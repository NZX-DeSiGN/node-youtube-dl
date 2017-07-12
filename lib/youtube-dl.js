var spawn       = require('child_process').spawn;
var fs          = require('fs');
var path        = require('path');
var url         = require('url');
var util        = require('./util');
var jsonstream  = require('JSONStream')
var ffmpeg      = require('ffmpeg-static');
var detailsPath = path.join(__dirname, '..', 'bin/details'), ytdlBinary;

if (fs.existsSync(detailsPath)) {
  var details = JSON.parse(fs.readFileSync(detailsPath));
  ytdlBinary = (details.path) ? details.path : path.resolve(__dirname, '..', 'bin', details.exec);
}

// Check that youtube-dl file exists.
if (!fs.existsSync(ytdlBinary)) {
  console.log('ERROR: unable to locate youtube-dl details in ' + path.dirname(ytdlBinary));
  process.exit(1);
}

var isDebug = /^\[debug\] /;
var isWarning = /^WARNING: /;
var isYouTubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//;
var isNoSubsRegex = /WARNING: video doesn't have subtitles|no closed captions found/;
var videoNotAvailable = /This video is not available|This video has been removed by the user|Please sign in to view this video/;
var subsRegex = /--write-sub|--write-srt|--srt-lang|--all-subs/;

/**
 * Downloads a video.
 *
 * @param {String} videoUrl
 * @param {!Array.<String>} args
 * @param {!Object} options
 */
var ytdl = module.exports = function(videoUrl, args, options, doneCallback, itemCallback) {
  'use strict';

  if (typeof options === 'function') {
    itemCallback = options;
    options = {};
  } else if (typeof args === 'function') {
    itemCallback = args;
    options = {};
    args = [];
  }

  // Print output as json
  var defaultArgs = ['--print-json'];

  if (!args || args.indexOf('-f') < 0 && args.indexOf('--format') < 0 &&
      args.every(function(a) {
        return a.indexOf('--format=') !== 0;
      })) {
    defaultArgs.push('-f');
    defaultArgs.push('best');
  }

  // Add ffmpeg location
  if (ffmpeg.path) {
    defaultArgs.push('--ffmpeg-location');
    defaultArgs.push(ffmpeg.path);
  }

  call(videoUrl, defaultArgs, args, options, itemCallback, doneCallback);
};

/**
 * Calls youtube-dl with some arguments and the `callback`
 * gets called with the output.
 *
 * @param {String|Array.<String>}
 * @param {Array.<String>} args
 * @param {Array.<String>} args2
 * @param {Object} options
 * @param {Function(!Error, String)} itemCallback
 * @param {Function()} doneCallback
 */
function call(urls, args1, args2, options, itemCallback, doneCallback) {
  'use strict';
  var args = args1;
  if (args2) {
    args = args.concat(args2);
  }
  options = options || {};

  // Ignore errors
  args.unshift('-i');

  if (urls !== null) {
    if (typeof urls === 'string') {
      urls = [urls];
    }

    for (var i = 0; i < urls.length; i++) {
      var video = urls[i];
      if (isYouTubeRegex.test(video)) {
        // Get possible IDs.
        var details = url.parse(video, true);
        var id = details.query.v || '';
        if (id) {
          args.push('http://www.youtube.com/watch?v=' + id);
        } else {
          // Get possible IDs for youtu.be from urladdr.
          id = details.pathname.slice(1).replace(/^v\//, '');
          if (id) {
            if ((id === 'playlist') && !options.maxBuffer) { options.maxBuffer = 7000 * 1024; }
            args.push(video);
          }
        }
      } else {
        args.push(video);
      }
    }
  }

  // Add youtubeDL path to args
  args.unshift(ytdlBinary);

  // Call youtube-dl.
  var child = spawn('python', args, options);

  var index = 0;
  var items = [];
  const hasItemCallback = typeof itemCallback === 'function';
  const hasDoneCallback = typeof doneCallback === 'function';

  child.stdout.pipe(jsonstream.parse()).on('data', function (data) {
    if (urls[index]) {
      try {
        // Parse data
        data = parseInfo(data, options.cwd);
        // Construct item
        const item = {
          data,
          error: null,
          url: urls[index]
        };
        // Call itemCallback
        if (hasItemCallback) itemCallback(null, item.data, item.url);
        // Add to items
        items.push(item);
      } catch (err) {
        itemCallback(err, null, urls[index]);
      }
    }
    // Increment url index
    index++;
  });

  child.stderr.on('data', function (stderr) {
    // Try once to download video if no subtitles available
    if (!options.nosubs && isNoSubsRegex.test(stderr)) {
      var i;
      var cleanupOpt = args2;

      for (i = cleanupOpt.length - 1; i >= 0; i--) {
        if (subsRegex.test(cleanupOpt[i])) { cleanupOpt.splice(i, 1); }
      }

      options.nosubs = true;

      return call(video, args1, cleanupOpt, options, itemCallback, doneCallback);

    }

    if (isDebug.test(stderr) && args.indexOf('--verbose') > -1) {
      console.log('\n' + stderr);
    } else if (isWarning.test(stderr)) {
      console.warn(stderr);
    } else if (hasItemCallback && urls[index]) {
      const item = {
        error: new Error(stderr.slice(7)),
        data: null,
        url: urls[index]
      };
      items.push(item);
      itemCallback(item.error, item.data, item.url);
    }

    // Increment url index
    index++;
  });

  child.on('close', function (code) {
    if (hasDoneCallback) doneCallback(null, items);
  });

  child.on('error', function (err) {
    if (hasDoneCallback) return doneCallback(err, items);
  });
}

/**
 * Calls youtube-dl with some arguments and the `callback`
 * gets called with the output.
 *
 * @param {String} url
 * @param {Array.<String>} args
 * @param {Object} options
 * @param {Function(!Error, String)} callback
 */
ytdl.exec = function exec(url, args, options, callback) {
  'use strict';
  return call(url, [], args, options, callback);
};


/**
 * @param {Object} data
 * @returns {Object}
 */
function parseInfo(info, cwd) {
  'use strict';

  // Add and process some entries to keep backwards compatibility
  Object.defineProperty(info, 'filename', {
    get: function get() {
      console.warn('`info.filename` is deprecated, use `info._filename`');
      return info._filename;
    }
  });
  Object.defineProperty(info, 'itag', {
    get: function get() {
      console.warn('`info.itag` is deprecated, use `info.format_id`');
      return info.format_id;
    }
  });
  Object.defineProperty(info, 'resolution', {
    get: function get() {
      console.warn('`info.resolution` is deprecated, use `info.format`');
      return info.format.split(' - ')[1];
    }
  });
  info.path = cwd || ''
  info.duration = util.formatDuration(info.duration);
  return info;
}


/**
 * Gets info from a video.
 *
 * @param {String} url
 * @param {Array.<String>} args
 * @param {Object} options
 * @param {Function(!Error, Object)} callback
 */
ytdl.getInfo = function getInfo(url, args, options, callback) {
  'use strict';
  if (typeof options === 'function') {
    callback = options;
    options = {};
  } else if (typeof args === 'function') {
    callback = args;
    options = {};
    args = [];
  }
  var defaultArgs = ['--dump-json', '--no-warnings'];
  if (!args || args.indexOf('-f') < 0 && args.indexOf('--format') < 0 &&
      args.every(function(a) {
        return a.indexOf('--format=') !== 0;
      })) {
    defaultArgs.push('-f');
    defaultArgs.push('best');
  }

  call(url, defaultArgs, args, options, function item(err, data, url) {
    if (err) { return callback(err, data, url); }
    callback(null, data, url);
  });
};


/**
 * @param {String} url
 * @param {!Array.<String>} args
 * @param {Function(!Error, Object)} callback
 */
ytdl.getFormats = function getFormats(url, args, callback) {
  'use strict';
  console.warn('`getFormats()` is deprecated. Please use `getInfo()`');

  if (typeof args === 'function') {
    callback = args;
    args = [];
  }

  ytdl.getInfo(url, args, {}, function item(err, video_info) {
    if (err) { return callback(err); }

    var formats_info = video_info.formats || [video_info];
    var formats = formats_info.map(function mapIt(format) {
        return {
          id: video_info.id,
          itag: format.format_id,
          filetype: format.ext,
          resolution: format.format.split(' - ')[1].split(' (')[0],
        };
    });

    callback(null, formats);
  });
};

/**
 * @param {String} url
 * @param {Object} options
 *   {Boolean} auto
 *   {Boolean} all
 *   {String} lang
 *   {String} cwd
 * @param {Function(!Error, Object)} callback
 */
ytdl.getSubs = function getSubs(url, options, callback) {
  'use strict';
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  var args = ['--skip-download'];
  args.push('--write' + (options.auto ? '-auto' : '') + '-sub');
  if (options.all) {
    args.push('--all-subs');
  }
  if (options.lang) {
    args.push('--sub-lang=' + options.lang);
  }
  if (!options.warrning) {
    args.push('--no-warnings');
  }

  call(url, args, [], { cwd: options.cwd }, function(err, data) {
    if (err) { return callback(err); }

    var files = [];
    for (var i = 0, len = data.length; i < len; i++) {
      var line = data[i];
      if (line.indexOf('[info] Writing video subtitles to: ') === 0) {
        files.push(line.slice(35));
      }
    }
    callback(null, files);
  });
};

/**
 * @param {!Boolean} descriptions
 * @param {!Object} options
 * @param {Function(!Error, Object)} callback
 */
ytdl.getExtractors = function getExtractors(descriptions, options, callback) {
  'use strict';
  if (typeof options === 'function') {
    callback = options;
    options = {};
  } else if (typeof descriptions === 'function') {
    callback = descriptions;
    options = {};
    descriptions = false;
  }

  var args = descriptions ?
    ['--extractor-descriptions'] : ['--list-extractors'];
  call(null, args, null, options, callback);
};