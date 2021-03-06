/**
 *           _ _                    _     
 *        __| (_) __ _  ___  ___   (_)___ 
 *       / _` | |/ _` |/ _ \/ __|  | / __|
 *      | (_| | | (_| |  __/\__ \_ | \__ \
 *       \__,_|_|\__,_|\___||___(_)/ |___/
 *                               |__/     
 *     
 *     Obfuscated audio playback for the web.
 *
 *
 * @version   1.0
 * @copyright 2016 - 2pulse
 * @author    Romain Liautaud <romain@liautaud.fr>
 */


'use strict';

var $ = require('jquery-browserify');
var Crypto = require('./crypto.js');

/**
 * Diaes.js obfuscates the audio files in two ways.
 *
 * - First, it splits the audio files into small pieces of
 *   10 seconds or less, called `fragments`.
 *
 *   Each fragment is given a `fragment number`: fragment
 *   number 0 contains the first 10 seconds of the file, 
 *   fragment number 1 the next 10 seconds, and so on.
 * 
 *   Each fragment is stored in a separate file on the
 *   server, whose path can be retrieved using
 *   	Reader.getFragmentPath(number);
 *
 * - Then, it encodes every fragment using AES-CBC, with
 *   a different 256 bit key for each fragment. This
 *   makes the audio files unreadable unless decoded.
 */

var FRAGMENT_DURATION = 15.0;

var STATE_PAUSED    = 0;
var STATE_PLAYING   = 1;
var STATE_BUFFERING = 2;
var STATE_FINISHED  = 3;

/**
 * Appends two AudioBuffers into a new one.
 * 
 * @param {AudioBuffer} buffer1 The first buffer.
 * @param {AudioBuffer} buffer2 The second buffer.
 */
function appendBuffer(context, buffer1, buffer2) {
	var numberOfChannels = Math.min( buffer1.numberOfChannels, buffer2.numberOfChannels );
	var tmp = context.createBuffer( numberOfChannels, (buffer1.length + buffer2.length), buffer1.sampleRate );
	for (var i=0; i<numberOfChannels; i++) {
		var channel = tmp.getChannelData(i);
		channel.set( buffer1.getChannelData(i), 0);
		channel.set( buffer2.getChannelData(i), buffer1.length);
	}
	return tmp;
}

/**
 * Returns whether the browser is capable of playing
 * Vorbis-encoded .ogg files.
 */
function canPlayVorbis() {
	var a = document.createElement('audio');

	return !!(a.canPlayType && a.canPlayType('audio/ogg; codecs="vorbis"').replace(/no/, ''));
}

/**
 * An audio source. Communicates with the Web Audio API to
 * play a given buffer, while keeping track of the timing
 * information for that buffer.
 */
var Source = function (buffer, queue) {
	// console.log('Instanciated source', buffer, queue);

	this.buffer = buffer;              // Audio buffer
	this.queue  = queue;               // Parent queue
	this.reader = queue.reader;        // Parent reader
	this.player = queue.reader.player; // Parent player

	this.node        = null;
	this.startsAt    = null;
	this.startsFrom  = 0;
	this.endTimer    = null;
	this.endCallback = null;
};

/**
 * Creates a new node to play the buffer, and computes the
 * time at which the node should begin playing according to
 * the current time and current content of the parent queue. 
 *
 * @param {int} index The index of the current element in the queue.
 */
Source.prototype.setup = function (index) {
	//console.log('Setup source', this);

	this.node = this.reader.context.createBufferSource();
	this.node.buffer = this.buffer;
	console.log("reader : ", this.reader)
	this.node.connect(this.reader.gain);


	if (index > 0) {
		var previous = this.queue.get(index - 1);
		
		this.startsAt = previous.startsAt + previous.buffer.duration - previous.startsFrom;
	} else {
		this.startsAt = this.reader.context.currentTime;
	}

	// console.log('New startsAt:', this.startsAt);
};

/**
 * Schedules the beginning and the end of the play.
 */
Source.prototype.schedule = function () {
	//console.log('Schedule source', this);

	var that = this;

	var endsAt = that.startsAt + that.buffer.duration - that.startsFrom;
	var endsIn = endsAt - that.reader.context.currentTime;

	try {
		that.node.start(that.startsAt, that.startsFrom);
	}
	catch (e) {
		console.log('error on schedule : ', e);
	}



	if (that.endTimer) {
		clearTimeout(that.endTimer);
	}

	that.endTimer = setTimeout(function () {
		if (that.endCallback) {
			that.endCallback();
		}

		if (that.queue) {
			that.queue.shift();
		}
	}, endsIn * 1000 + 200);
};

/**
 * Cancels any previously scheduled event.
 */
Source.prototype.cancel = function () {
	// console.log('Cancel source', this);

	this.node && this.node.disconnect();
	clearTimeout(this.endTimer);
	this.endTimer = null;
};

/**
 * Destroys the audio source.
 */
Source.prototype.destroy = function () {

	this.cancel();

	delete this.buffer;
	delete this.queue;
	delete this.reader;
	delete this.player;

	//delete this.node;
	delete this.startsAt;
	delete this.startsFrom;
	delete this.endTimer;
	delete this.endCallback;


};

/**
 * Computes the elapsed playing time.
 */
Source.prototype.elapsed = function () {
	return this.reader.context.currentTime - this.startsAt + this.startsFrom;
};

// -------------------------------------------------------------------- //

/**
 * An audio source queue. Manages several audio sources, and plays
 * them in the order they were queued.
 */
var SourceQueue = function (reader) {
	this.reader = reader; // Parent reader

	this.state = STATE_PAUSED;
	this.sources = [];
	this.latestElapsed = 0;
};

/**
 * Checks whether the queue is empty.
 */
SourceQueue.prototype.isEmpty = function () {
	return this.sources.length == 0;
};

/**
 * Fetches a source from the queue.
 */
SourceQueue.prototype.get = function (index) {
	return this.sources[index];
}

/**
 * Fetches the first inserted source of the queue.
 */
SourceQueue.prototype.first = function () {
	return this.get(0);
};

/**
 * Fetches the last inserted source of the queue.
 */
SourceQueue.prototype.last = function () {
	return this.get(this.sources.length - 1);
};

/**
 * Removes the first inserted source from the queue.
 */
SourceQueue.prototype.shift = function () {
	this.first().destroy();
	
	this.sources.shift();
};

/**
 * Adds a buffer to the queue.
 */
SourceQueue.prototype.push = function (buffer, number, beforeSetup) {
	// console.log('Pushing to the queue', buffer);

	var source = new Source(buffer, this);
	var sourceIndex = this.sources.length;

	if (_.find(this.queue, {number: number}))
		return ;

	source.number = number;
	this.sources.push(source);

	if (typeof beforeSetup !== 'undefined') {
		beforeSetup(source);
	}

	if (this.state == STATE_PLAYING) {
		source.setup(sourceIndex);
		source.schedule();
	}

	return source;
};

/**
 * Removes all the sources from the queue.
 */
SourceQueue.prototype.empty = function () {
	while (!this.isEmpty()) {
		this.shift();
	}
};

/**
 * Plays the queue's sources.
 */
SourceQueue.prototype.play = function () {
	if (this.state == STATE_PLAYING) {
		return;
	}
	if (this.state == STATE_FINISHED) {
		return this.reader.setCurrentTime(0);
	}

	this.latestElapsed = null;
	this.state = STATE_PLAYING;
	// TODO: Move elsewhere
	this.reader.playingInterval = setInterval(this.reader.player.whilePlaying, 500);
	this.reader.player.onPlay();

	for (var i = 0; i < this.sources.length; i++) {
		var source = this.get(i);
		source.setup(i);
		source.schedule();
	}
};

/** 
 * Pauses the playing of the queue's sources.
 */
SourceQueue.prototype.pause = function () {
	if (this.state == STATE_PAUSED) {
		return;
	}

	if (!this.isEmpty()) {
		this.latestElapsed = this.first().elapsed();
	}

	this.state = STATE_PAUSED;
	window.clearInterval(this.reader.playingInterval);
	this.reader.player.onPause();

	for (var i = 0; i < this.sources.length; i++) {
		this.get(i).cancel();
	}

	if (!this.isEmpty()) {
		this.first().startsFrom = this.first().elapsed();
	}
};

/**
 * Returns the time that was actually elapsed.
 */
SourceQueue.prototype.elapsed = function () {
	if (this.latestElapsed !== null) {
		return this.latestElapsed;
	} else if (this.isEmpty()) {
		return 0;
	} else {
		return this.first().elapsed();
	}
};

// -------------------------------------------------------------------- //

/**
 * An audio reader. Fetches the fragments of the audio file,
 * and manages them using an audio source queue.
 */
var Reader = function (path, player) {
	this.path   = path;   // Path to the file metadata
	this.player = player; // Parent player

	this.fragments = [];
	this.queue = new SourceQueue(this);
	this.currentFragmentNumber = 0;
	this.buffering = false;
	this.duration = null;
	this.jumped = false;

	this.manager = this.player.manager;
	this.context = this.manager.context;
	this.gain = this.manager.gain;

	this.playingInterval = null;

	var that = this;

	that.player.onBufferingStart();
	that.buffering = true;
	console.log(this.context.state);

	that.fetchMetadata(function () {
		that.player.onMetadataFetched();

		that.loadFragment(0, function () {
			if (that.jumped)
				return ;
			that.scheduleFragment(0, 0);
			that.player.onBufferingStop();
			that.buffering = false;
			that.loadAndScheduleFragment(1);
		});
	});
};

/**
 * Fetches the file's metadata.
 */
Reader.prototype.fetchMetadata = function (callback) {
	var that = this;

	$.getJSON(this.path, { 
		bust: (new Date()).getTime() 
	}).done(function (metadata) {
		that.duration = metadata.duration;
		
		$.each(metadata.fragments, function (index, fragment) {
			that.fragments.push({
				buffer: null,
				mpath: fragment.mpath,
				vpath: fragment.vpath,
				key: fragment.key,
				iv: fragment.iv
			});
		});

		callback();
	}).fail(function (xhr) {
		that.player.onMetadataError($.parseJSON(xhr.responseText));
	});
};

/**
 * Returns the fragment number associated with a time.
 */
Reader.prototype.getFragmentNumber = function (time) {
	return Math.floor(time / FRAGMENT_DURATION);
};

/**
 * Converts a hex string into a Uint8Array.
 */
Reader.prototype.convertHex = function (hex) {
	var bytes = [];
	hex = hex.trim();

	for (var c = 0; c < hex.length; c += 2) {
		bytes.push(parseInt(hex.substr(c, 2), 16));
	}

	return new Uint8Array(bytes);
};

/**
 * Decodes the given ArrayBuffer.
 */
Reader.prototype.decodeFragment = function (number, encodedRawBuffer) {
	if (this.fragments[number].decoded) {
		return encodedRawBuffer;
	}

	// https://github.com/wader/aes-arraybuffer
	var key = this.convertHex(this.fragments[number].key).buffer;
	var iv  = this.convertHex(this.fragments[number].iv).buffer;

	return Crypto.pkcs_unpad(Crypto.decrypt_aes_cbc(encodedRawBuffer, key, iv));
};

/**
 * Fetches a given fragment, decodes it, and passes
 * the binary data to the callback.
 */
Reader.prototype.fetchFragment = function (number, callback) {
	var that = this;
	var request = new XMLHttpRequest();

	if (canPlayVorbis()) {
		var path = that.fragments[number].vpath;
	} else {
		var path = that.fragments[number].mpath;
	}

	request.open('GET', path, true);
	request.responseType = 'arraybuffer';
	request.onload = function () {
		var encodedRawBuffer = request.response;

		callback(number, that.decodeFragment(number, encodedRawBuffer));
	};

	request.send();
};

/**
 * Checks whether a given fragment is loaded into memory.
 */
Reader.prototype.isFragmentLoaded = function (number) {
	return this.fragments[number].buffer !== null;
}

/**
 * Loads a given fragment into memory.
 */
Reader.prototype.loadFragment = function (number, callback) {
	// Maybe the fragment doesn't exist?
	if (!this.fragments || !this.fragments.length)
		console.log('no fragments');
	if (number >= this.fragments.length) {
		return;
	}

	// Maybe the fragment was already loaded?
	if (this.isFragmentLoaded(number)) {
		callback(number);
		return;
	}

	var that = this;

	that.fetchFragment(number, function (number, decodedRawBuffer) {
		that.context.decodeAudioData(decodedRawBuffer, function (audioBuffer) {
			that.fragments[number].buffer = audioBuffer;

			callback(number);
		});
	});
};

/**
 * Schedules the given fragment to start playing right
 * after the current one.
 *
 * The fragment must already be loaded into memory.
 */
Reader.prototype.scheduleFragment = function (number, offset) {
	// console.log('Scheduling fragment ' + number + ' with offset ' + offset);

	var that = this;

	that.queue.push(that.fragments[number].buffer, number, function (source) {
		source.endCallback = function () {
			console.log('endCallback called for fragment ', number);
			that.currentFragmentNumber = number + 1;

			// Maybe we don't have any fragments left to queue?
			if (that.currentFragmentNumber >= that.fragments.length) {
				that.queue.pause();
				that.queue.state = STATE_FINISHED;
				that.player.onFinish();
			}
			
			// Make sure we load the n + 2 fragment when this one ends.
			that.loadAndScheduleFragment(number + 2);
		};

		// Maybe we must start playing the fragment with a given offset?
		if (offset) {
			// console.log('startsFrom set to', offset);
			source.startsFrom = offset;
		}
	});
};

/**
 * Loads and schedules a given fragment.
 */
Reader.prototype.loadAndScheduleFragment = function (number, offset, callback) {
	callback = callback || function () {};
	var that = this;

	that.loadFragment(number, function () {
		that.scheduleFragment(number, offset);

		callback();
	});
};

/**
 * Returns the state of the player, which is the state
 * of the underlying queue unless the player is buffering.
 */
Reader.prototype.state = function () {
	if (this.buffering) {
		return STATE_BUFFERING;
	} else {
		return this.queue.state;
	}
};

/**
 * Computes the total elapsed time.
 */
Reader.prototype.getCurrentTime = function () {
	return this.currentFragmentNumber * FRAGMENT_DURATION + this.queue.elapsed();
};

/**
 * Seeks to a given time in the track.
 */
Reader.prototype.setCurrentTime = _.debounce(function (time) {
	var that = this;

	that.jumped = true;

	if (!that.fragments.length) {
		var waitingFragments = window.setInterval(function () {
			if (!that.fragments.length)
				return ;

			window.clearInterval(waitingFragments);

			setup();
		}, 100)
	} else {
		setup();
	}

	function setup () {
		var number = that.getFragmentNumber(time);
		var offset = time % FRAGMENT_DURATION;
		that.currentFragmentNumber = number;

		that.queue.pause();
		that.buffering = true;
		that.player.onBufferingStart();	

		that.queue.empty();

		that.loadFragment(number, function () {
			if (that.currentFragmentNumber !== number)
				return ;
			that.player.onBufferingStop();
			that.buffering = false;

			that.queue.play();

			that.scheduleFragment(number, offset);

			that.loadAndScheduleFragment(number + 1);
		});
	}
}, 300);

/**
 * Destroys the audio reader.
 */
Reader.prototype.destroy = function () {
	this.queue.empty();
	this.fragments = [];

	delete this.player;
	delete this.queue;

	delete this.manager;
	delete this.context;
	delete this.gain;
};

// -------------------------------------------------------------------- //

/**
 * An audio player which mimics the HTMLAudioElement interface.
 */
var Player = function (path, manager, config, id) {
	_.extend(this, config);

	this.manager = manager;
	this.id = id;
	this.reader  = new Reader(path, this);
};

Player.prototype = {
	get paused() {
		return this.reader.state() == STATE_PAUSED;
	},

	get finished() {
		return this.reader.state() == STATE_FINISHED;
	},

	get currentTime() {
		return this.reader.getCurrentTime();
	},

	set currentTime(time) {
		this.reader.setCurrentTime(time);
	},

	get duration() {
		return this.reader.duration;
	},

	// Player callbacks
	onMetadataFetched: function() {
		console.info('onMetadataFetched');
	},
	onMetadataError: function(error) {
		console.info('onMetadataError', error);
	},
	onPlay: function() {
		console.info('onPlay');
	},
	onPause: function() {
		console.info('onPause');
	},
	onFinish: function() {
		console.info('onFinish');
	},
	onBufferingStart: function() {
		console.info('onBufferingStart');
	},
	onBufferingStop: function() {
		console.info('onBufferingStop');
	},
	whilePlaying: function() {
		console.info('whilePlaying');
	}
};

/**
 * Resumes the audio player.
 */
Player.prototype.play = function () {
	this.reader.queue.play();
};

/**
 * Pauses the audio player.
 */
Player.prototype.pause = function () {
	this.reader.queue.pause();
};

/**
 * Destroys the audio player.
 */
Player.prototype.destroy = function () {
	this.reader.destroy();

	delete this.reader;
	delete this.manager;
};

// -------------------------------------------------------------------- //

/**
 * An audio player manager. Manages multiple audio player
 * instances, which all share a common AudioContext and
 * gain node.
 */
var Manager = function () {
	this.context = new (window.AudioContext || window.webkitAudioContext)();
	console.log("context ", this.context)
	var that = this;
	if (this.context.state !== "running") {
		fix(this.context);
		setup();
	}
	else {
		setup();
	}

	function fixSuspendedState(ac) {  
		if(ac.state == 'suspended') {    
			console.warn('AudioContext FIX: suspended. Try to wake it.')
			if(ac.resume) {      
				ac.resume();
			}
			return ac.state == 'running';
		} else {
			console.warn('AudioContext FIX: not suspended, nothing to do.')    
			return true;
		}
	}

	function fix(ac) {  
		if(ac.state == 'running') 
			return ;
		setTimeout(function() {    
			var fixed = fixSuspendedState(ac);
			console.warn('AudioContext FIX: Applied, state is', fixed);
		}, 2000)
	}

	function setup() {
		console.log("setup ", that.context.state);
		that.gain = that.context.createGain();
		that.gain.connect(that.context.destination);

		/*
		 * iOS attempts user action in order to play sound with the Web Audio API.
		 * Here we play an empty sound on touchend event to unlock this limitation. 
		 */
		window.addEventListener("touchend", iosUnlockSound.bind(that), false);
	};

	function iosUnlockSound(event) {
  		var buffer = this.context.createBuffer(1, 1, 22050);
  		var source = this.context.createBufferSource();
  		source.buffer = buffer;
  		source.connect(this.context.destination);
  		source.noteOn(0);
  		window.removeEventListener("touchend", iosUnlockSound, false);
	}
};

Manager.prototype = {
	players: [],
	muted: false,
	volume: 1.0,

	onMute: function() {},
	onUnmute: function() {},
	onVolumeChange: function() {}
};

/**
 * Adds a new player to the manager.
 */
Manager.prototype.add = function (path, config) {
	var player = new Player(path, this, config, this.players.length);

	this.players.push(player);

	return player;
};

/**
 * Destroys all but the last player from the manager.
 */
Manager.prototype.destroyUnused = function () { // todo: pas le dernier !
	while (this.players.length > 1) {
		var unused = this.players.shift();

		unused.destroy();
	}
};

/**
 * Mutes every managed player.
 */
Manager.prototype.mute = function () {
	this.muted = true;
	this.gain.gain.value = 0.0;

	this.onMute();
};

/**
 * Unmutes every managed player.
 */
Manager.prototype.unmute = function () {
	this.muted = false;
	this.setVolume(this.volume);

	this.onUnmute();
};

/**
 * Sets the volume of every manager player.
 */
Manager.prototype.setVolume = function (volume) {
	this.volume = volume;
	this.gain.gain.value = volume;

	this.onVolumeChange();
};

/**
 * Pauses every managed player.
 */
Manager.prototype.pauseAll = function (id) {
	for (var i = 0; i < this.players.length; i++) {
		this.players[i].pause();
		if (this.players[i].reader.buffering && this.players[i].id !== id) {
			var that = this;
			var interval = window.setInterval((function () {
				if (!this.reader.buffering) {
					this.pause();
					window.clearInterval(interval);
				}
			}).bind(this.players[i]), 10)
		}
	}
};

// -------------------------------------------------------------------- //

module.exports = {
	Player: Player,
	Manager: Manager
};

