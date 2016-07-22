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

define(['jquery', 'Crypto'], function ($, Crypto) {
	'use strict';

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
	 *   a different 128 bit key for each fragment. This
	 *   makes the audio files unreadable unless decoded.
	 */

	const FRAGMENT_DURATION = 15.0;

	const STATE_PAUSED    = 0;
	const STATE_PLAYING   = 1;
	const STATE_BUFFERING = 2;
	const STATE_ENDED     = 3;

	/**
	 * An audio source. Communicates with the Web Audio API to
	 * play a given buffer, while keeping track of the timing
	 * information for that buffer.
	 */
	var Source = function (buffer, queue) {
		console.log('Instanciated source', buffer, queue);

		this.buffer = buffer;              // Audio buffer
		this.queue  = queue;               // Parent queue
		this.reader = queue.reader;        // Parent reader
		this.player = queue.reader.player; // Parent player

		this.node = null;
		this.startsAt = null;
		this.startsFrom = 0;
		this.endTimer = null;
		this.endCallback = null;
	};

	/**
	 * Creates a new node to play the buffer, and computes the
	 * time at which the node should begin playing according to
	 * the current time and current content of the parent queue. 
	 *
	 * @param int index The index of the current element in the queue.
	 */
	Source.prototype.setup = function (index) {
		console.log('Setup source', this);

		this.node = this.reader.context.createBufferSource();
		this.node.buffer = this.buffer;
		this.node.connect(this.reader.gain);

		if (index > 0) {
			this.startsAt = this.reader.context.currentTime + this.queue.get(index - 1).remaining();
		} else {
			this.startsAt = this.reader.context.currentTime;
		}

		console.log('New startsAt:', this.startsAt);
	};

	/**
	 * Schedules the beginning and the end of the play.
	 */
	Source.prototype.schedule = function () {
		console.log('Schedule source', this);

		var that = this;

		that.node.start(that.startsAt, that.startsFrom);

		var endsAt = that.startsAt + that.buffer.duration;
		var endsIn = endsAt - that.reader.context.currentTime;

		console.log('endsIn:', endsIn);

		if (that.endTimer) {
			clearTimeout(that.endTimer);
		}

		that.endTimer = setTimeout(function () {
			console.log('Source ended 100ms ago', that);

			if (that.endCallback) {
				that.endCallback();
			}

			that.queue.shift();
		}, endsIn * 1000 + 100);
	};

	/**
	 * Cancels any previously scheduled event.
	 */
	Source.prototype.cancel = function () {
		console.log('Cancel source', this);

		this.node.stop();
		clearTimeout(this.endTimer);
		this.endTimer = null;
	};

	/**
	 * Destroys the audio source.
	 */
	Source.prototype.destroy = function () {
		this.cancel();
		delete this.buffer;
		delete this.queue ;
		delete this.reader;
		delete this.player;

		delete this.node;
		delete this.startsAt;
		delete this.startsFrom;
		delete this.endTimer;
		delete this.endCallback;
	};

	/**
	 * Computes the elapsed playing time.
	 */
	Source.prototype.elapsed = function () {
		return this.reader.context.currentTime - this.startsAt;
	};

	/**
	 * Computes the remaining playing time.
	 */
	Source.prototype.remaining = function () {
		return this.buffer.duration - this.elapsed();
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
	SourceQueue.prototype.push = function (buffer) {
		console.log('Pushing to the queue', buffer);

		var source = new Source(buffer, this);
		var sourceIndex = this.sources.length;

		this.sources.push(source);

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

		for (var i = 0; i < this.sources.length; i++) {
			this.get(i).cancel();
		}

		if (!this.isEmpty()) {
			this.first().startsFrom += this.first.elapsed();
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
		this.previousFragmentsElapsed = 0.0;
		this.currentFragmentNumber = 0;
		this.buffering = false;
		this.duration = null;

		this.manager = this.player.manager;
		this.context = this.manager.context;
		this.gain    = this.manager.gain;

		var that = this;

		that.fetchMetadata(function () {
			that.loadAndScheduleFragment(0);
			that.loadAndScheduleFragment(1);
		});
	};

	/**
	 * Fetches the file's metadata.
	 */
	Reader.prototype.fetchMetadata = function (callback) {
		var that = this;

		$.getJSON(this.path, function (metadata) {
			that.duration = metadata.duration;
			
			$.each(metadata.fragments, function (index, fragment) {
				that.fragments.push({
					buffer: null,
					path: fragment.path,
					key: fragment.key,
					iv: fragment.iv
				});
			});

			callback();
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
		var path = that.fragments[number].path;
		var request = new XMLHttpRequest();

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
		console.log('Scheduling fragment ' + number + ' with offset ' + offset);

		var that = this;

		var source = that.queue.push(that.fragments[number].buffer);

		source.endCallback = function () {
			that.previousFragmentsElapsed += source.buffer.duration;
			that.currentFragmentNumber += 1;
			
			// Make sure we load the n + 2 fragment when this one ends.
			that.loadAndScheduleFragment(number + 2);
		};

		// Maybe we must start playing the fragment with a given offset?
		if (offset) {
			source.startsFrom = offset;
		}
	};

	/**
	 * Loads and schedules a given fragment.
	 */
	Reader.prototype.loadAndScheduleFragment = function (number, offset) {
		var that = this;

		that.loadFragment(number, function () {
			that.scheduleFragment(number, offset);
		});
	};

	/**
	 * Returns the state of the player, which is the state
	 * of the underlying queue unless the player is buffering.
	 */
	Reader.prototype.state = function () {
		if (this.buffering) {
			return STATE_BUFFERING;
		} else if (this.queue.isEmpty()) {
			return STATE_ENDED;
		} else {
			return this.queue.state;
		}
	};

	/**
	 * Computes the total elapsed time.
	 */
	Reader.prototype.getCurrentTime = function () {
		return this.previousFragmentsElapsed + this.queue.first().elapsed();
	};

	/**
	 * Seeks to a given time in the track.
	 */
	Reader.prototype.setCurrentTime = function (time) {
		var that = this;

		var number = that.getFragmentNumber(time);
		var offset = time % FRAGMENT_DURATION;

		that.buffering = true;
		that.queue.empty();

		that.loadFragment(number, function () {
			that.buffering = false;
			that.scheduleFragment(number, offset);
		});
	};

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
	var Player = function (path, manager) {
		this.manager = manager;
		this.reader  = new Reader(path, this);
	};

	Player.prototype = {
		// Player options
		autoplay: false,
		loop: false,

		// Player current state
		properties: {
			muted: false,
			volume: 1.0,
		},

		get paused() {
			return this.reader.state() == STATE_PAUSED;
		},

		get ended() {
			return this.reader.state() == STATE_ENDED;
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
		onPlay: function() {
			console.info('onPlay');
		},
		onPause: function() {
			console.log('onPause');
		},
		onEnded: function() {
			console.log('onEnded');
		},
		onBufferingStart: function() {
			console.log('onBufferingStart');
		},
		onBufferingStop: function() {
			console.log('onBufferingStop');
		},
		whilePlaying: function() {
			console.log('whilePlaying');
		}
	};

	/**
	 * Resumes the audio player.
	 */
	Player.prototype.play = function () {
		this.reader.queue.play();
		this.onPlay();
	};

	/**
	 * Pauses the audio player.
	 */
	Player.prototype.pause = function () {
		this.reader.queue.pause();
		this.onPause();
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
		this.gain = this.context.createGain();
		this.gain.connect(this.context.destination);
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
	Manager.prototype.add = function (path) {
		var player = new Player(path, this);

		this.players.push(player);

		return player;
	};

	/**
	 * Destroys all but the last player from the manager.
	 */
	Manager.prototype.destroyUnused = function () {
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
		this.reader.gain.gain.value = this.properties.volume;

		this.onVolumeChange();
	};

	/**
	 * Pauses every managed player.
	 */
	Manager.prototype.pauseAll = function () {
		for (var i = 0; i < this.players.length; i++) {
			this.players[i].pause();
		}
	};

	// -------------------------------------------------------------------- //

	return {
		Player: Player,
		Manager: Manager
	};
});