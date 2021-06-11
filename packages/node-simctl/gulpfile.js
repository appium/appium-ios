"use strict";

var gulp = require('gulp')
  , merge = require('merge-stream')
  , sourcemaps = require('gulp-sourcemaps')
  , traceur = require('gulp-traceur')
  , clear = require('clear')
  , Q = require('q')
  , runSequence = Q.denodeify(require('run-sequence'));

var argv   = require('yargs')
              .count('prod')
              .argv;

var exitOnError = false;

var traceurOpts = {
  asyncFunctions: true,
  blockBinding: true,
  modules: 'commonjs',
  annotations: true,
  arrayComprehension: true,
  sourceMaps: true,
  types: true
};

var getTraceurStream = function (src, dest) {
  return gulp.src(src)
              .pipe(sourcemaps.init())
              .pipe(traceur(traceurOpts))
              .pipe(sourcemaps.write())
              .pipe(gulp.dest(dest));
};

var transpile = function () {
  var lib = getTraceurStream('lib/es6/**/*.js', 'lib/es5');
  var test = getTraceurStream('test/es6/**/*.js', 'test/es5');
  return merge(lib, test);
};

gulp.task('transpile', function () {
  if (!argv.prod) {
    traceurOpts.typeAssertions = true;
    traceurOpts.typeAssertionModule = 'rtts-assert';
  }
  transpile();
});

gulp.task('kill-gulp', function() {
  process.exit(0);
});

gulp.task('clear-terminal', function() {
  clear();
  return Q.delay(100);
})

// gulp error handling is not very well geared toward watch
// so we have to do that to be safe.
// that should not be needed in gulp 4.0
gulp.task('watch-build', function() {
  return runSequence('clear-terminal', ['transpile']);
});
gulp.task('watch', function () {
  exitOnError = true;
  gulp.watch(['lib/es6/**/*.js', 'test/es6/**/*.js'], ['watch-build']);
  gulp.watch('gulpfile.js', ['clear-terminal','kill-gulp']);
});
gulp.task('spawn-watch', ['clear-terminal'], function() {
 var spawnWatch = function() {
    var proc = require('child_process').spawn('./node_modules/.bin/gulp', ['watch'], {stdio: 'inherit'});
    proc.on('close', function (code) {
      spawnWatch()
    });
  }
  spawnWatch();
})

// default target is watch
gulp.task('default', ['spawn-watch']);

