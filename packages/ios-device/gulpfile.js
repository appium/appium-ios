'use strict';

const gulp = require('gulp');
const boilerplate = require('@appium/gulp-plugins').boilerplate.use(gulp);

gulp.task('copy-files-for-build', () =>
  gulp.src('./test/fixtures/*').pipe(gulp.dest('./build/test/fixtures')),
);

boilerplate({
  build: 'appium-ios-device',
  coverage: {
    files: ['./build/test/unit/**/*-specs.js', '!./build/test/functional/**'],
    verbose: false,
  },
  test: {
    exit: true,
  },
  postTranspile: ['copy-files-for-build'],
});
