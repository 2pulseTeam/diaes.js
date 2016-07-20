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

define(['Crypto'], function (Crypto) {
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
	 * - Then, it encodes every fragment using AES-CTR, with
	 *   a different 128 bit key for each fragment. This
	 *   makes the audio files unreadable unless decoded.
	 */

	const FRAGMENT_DURATION = 7.0;

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
		this.buffer = buffer;       // Audio buffer
		this.queue  = queue;        // Parent queue
		this.reader = queue.reader; // Parent reader

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
		this.node = that.context.createBufferSource();
		this.node.connect(this.reader.gain);

		if (index > 0) {
			this.startsAt = this.reader.context.currentTime + this.queue.get(index - 1).remaining();
		} else {
			this.startsAt = this.reader.context.currentTime;
		}
	};

	/**
	 * Schedules the beginning and the end of the play.
	 */
	Source.prototype.schedule = function () {
		this.node.start(this.startsAt, this.startsFrom);

		var that = this;
		var endsAt = this.startsAt + this.buffer.duration;
		var endsIn = this.endsAt - this.reader.context.currentTime;

		if (this.endTimer) {
			clearTimeout(this.endTimer);
		}

		this.endTimer = setTimeout(function () {
			that.queue.shift();

			if (this.first().endCallback) {
				this.first().endCallback();
			}
		}, endsIn);
	};

	/**
	 * Cancels any previously scheduled event.
	 */
	Source.prototype.cancel = function () {
		this.buffer.stop();

		clearTimeout(this.endTimer);

		this.endTimer = null;
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
		this.first().cancel();
		
		this.sources.shift();
	};

	/**
	 * Adds a buffer to the queue.
	 */
	SourceQueue.prototype.push = function (buffer) {
		var source = new Source(buffer, this);
		var sourceIndex = this.sources.length;

		this.sources.push(source);

		if (this.state == STATE_PLAYING) {
			source.setup(sourceIndex);
			source.schedule();
		}
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

		for (i in this.sources) {
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

		for (i in this.sources) {
			this.get(i).cancel();
		}

		if (!this.isEmpty()) {
			this.first().startsFrom += this.first.elapsed();
		}
	};


	/**
	 * An audio reader. Fetches the fragments of the audio file,
	 * and manages them using an audio source queue.
	 */
	var Reader = function (path, id) {
		this.path = path;
		this.id = id;

		this.context = new (window.AudioContext || window.webkitAudioContext)();
		this.buffers = {};
		this.queue = new SourceQueue(this);
		this.previousFragmentsElapsed = 0.0;
		this.currentFragmentNumber = 0;
		this.buffering = false;

		this.gain = this.context.createGain();
		this.gain.connect(this.context.destination);

		this.loadAndScheduleFragment(0);
		this.loadAndScheduleFragment(1);
	};

	/**
	 * Returns the fragment number associated with a time.
	 */
	Reader.prototype.getFragmentNumber = function (time) {
		return Math.floor(time / FRAGMENT_DURATION);
	};

	/**
	 * Returns the path of a given audio fragment.
	 */
	Reader.prototype.getFragmentPath = function (number) {
		// TODO
		return;
		var separator = this.path.slice(-1) == '/' ? '' : '/';

		return this.path + separator + this.id + '-' + sha1(this.id + '-' + this.number);
	};

	/**
	 * Returns the key which should be used to decode
	 * a given fragment.
	 */
	Reader.prototype.getFragmentKey = function (number) {
		var key = new Uint8Array([
			0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
			0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef
		]); // todo

		return key.buffer;
	};

	/**
	 * Decodes the given ArrayBuffer.
	 */
	Reader.prototype.decodeFragment = function (number, buffer) {
		return buffer; //todo

		var key = this.getFragmentKey(number);
		var iv = new Uint8Array([
			0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
			0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef
		]);

		return Crypto.pkcs_unpad(Crypto.decrypt_aes_cbc(buffer, key, iv.buffer));
	};

	/**
	 * Fetches a given fragment, decodes it, and passes
	 * the binary data to the callback.
	 */
	Reader.prototype.fetchFragment = function (number, callback) {
		var that = this;
		var path = this.getFragmentPath(number);
		var request = new XMLHttpRequest();

		request.open('GET', path, true);
		request.responseType = 'arraybuffer';
		request.onload = function () {
			var buffer = request.response;

			callback(number, that.decodeFragment(number, buffer));
		};

		request.send();
	};

	/**
	 * Checks whether a given fragment is loaded into memory.
	 */
	Reader.prototype.isFragmentLoaded = function (number) {
		return number in this.buffers;
	}

	/**
	 * Loads a given fragment into memory.
	 */
	Reader.prototype.loadFragment = function (number, callback) {
		var that = this;

		// Maybe the fragment was already loaded?
		if (that.isFragmentLoaded(number)) {
			callback(number);
			return;
		}

		// Otherwise, fetch the fragment and create
		// the matching AudioBuffer.
		that.fetchFragment(number, function (number, data) {
			that.context.decodeAudioData(data, function (buffer) {
				that.buffers[number] = buffer;

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
		var source = that.queue.push(that.buffers[number]);

		source.endCallback = function () {
			this.previousFragmentsElapsed += source.buffer.duration;
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
	 * An audio player which mimics the HTMLAudioElement interface.
	 */
	var Player = function (path, id) {
		this.reader = new Reader(path, id);
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

		get muted() {
			return this.properties.volume;
		},

		set muted(muted) {
			this.properties.muted = muted;
			this.onMutedChange();
		},

		get volume() {
			return this.properties.volume;
		},

		set volume(volume) {
			this.properties.volume = volume;
			this.onVolumeChange();
		},

		get currentTime() {
			return this.reader.getCurrentTime();
		},

		set currentTime(time) {
			this.reader.setCurrentTime(time);
		},

		// Audio file metadata
		metadata: {}, //todo

		get duration() {
			return this.metadata.duration; //todo
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
	 * Triggers when the player gets (un)muted.
	 */
	Player.prototype.onMutedChange = function() {
		if (this.properties.muted) {
			this.reader.gain.gain.value = 0.0;
		} else {
			this.onVolumeChange();
		}
	};

	/**
	 * Triggers when the player's volume changes.
	 */
	Player.prototype.onVolumeChange = function() {
		this.reader.gain.gain.value = this.properties.volume;
	};

	return {
		Player: Player,
		Crypto: Crypto
	};
});

// https://github.com/wader/aes-arraybuffer