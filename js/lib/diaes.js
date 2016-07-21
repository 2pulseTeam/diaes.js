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
		this.buffer = buffer;        // Audio buffer
		this.queue  = queue;         // Parent queue
		this.reader = queue.reader;  // Parent reader
		this.player = reader.player; // Parent player

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
		this.node = this.context.createBufferSource();
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

		var endsAt = this.startsAt + this.buffer.duration;
		var endsIn = this.endsAt - this.reader.context.currentTime;

		if (this.endTimer) {
			clearTimeout(this.endTimer);
		}

		this.endTimer = setTimeout(function () {
			this.queue.shift();

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
	var Reader = function (path) {
		this.path = path;

		this.context = new (window.AudioContext || window.webkitAudioContext)();
		this.fragments = [];
		this.queue = new SourceQueue(this);
		this.previousFragmentsElapsed = 0.0;
		this.currentFragmentNumber = 0;
		this.buffering = false;
		this.duration = null;

		this.gain = this.context.createGain();
		this.gain.connect(this.context.destination);

		this.fetchMetadata(function () {
			this.loadAndScheduleFragment(0);
			this.loadAndScheduleFragment(1);
		});
	};

	/**
	 * Fetches the file's metadata.
	 */
	Reader.prototype.fetchMetadata = function (callback) {
		var that = this;

		// TODO : Remplacer ce code si besoin (JWT etc.)
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
		var path = this.fragments[number].path;
		var request = new XMLHttpRequest();

		request.open('GET', path, true);
		request.responseType = 'arraybuffer';
		request.onload = function () {
			var encodedRawBuffer = request.response;

			callback(number, this.decodeFragment(number, encodedRawBuffer));
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

		// Otherwise, fetch the fragment and create
		// the matching AudioBuffer.
		this.fetchFragment(number, function (number, decodedRawBuffer) {
			this.context.decodeAudioData(decodedRawBuffer, function (audioBuffer) {
				this.fragments[number].buffer = audioBuffer;

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

		var source = this.queue.push(this.fragments[number].buffer);

		source.endCallback = function () {
			this.previousFragmentsElapsed += source.buffer.duration;
			this.currentFragmentNumber += 1;
			
			// Make sure we load the n + 2 fragment when this one ends.
			this.loadAndScheduleFragment(number + 2);
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
		this.loadFragment(number, function () {
			this.scheduleFragment(number, offset);
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
		var number = this.getFragmentNumber(time);
		var offset = time % FRAGMENT_DURATION;

		this.buffering = true;
		this.queue.empty();

		this.loadFragment(number, function () {
			this.buffering = false;
			this.scheduleFragment(number, offset);
		});
	};

	/**
	 * An audio player which mimics the HTMLAudioElement interface.
	 */
	var Player = function (path) {
		this.reader = new Reader(path);
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

		get duration() {
			return this.reader.duration;
		},

		// Player callbacks
		onPlay: function() {},
		onPause: function() {},
		onStop: function() {},
		onEnded: function() {},
		onLoaded: function() {},
		whilePlaying: function() {},
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
		Player: Player
	};
});