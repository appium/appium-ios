'use strict';

const gulp = require('gulp');
const boilerplate = require('@appium/gulp-plugins').boilerplate.use(gulp);

gulp.task('copy-files-for-build', () =>
  gulp
    .src([
      './test/assets/sample.plist',
      './test/assets/test-pem.pem',
      './test/assets/TestApp-iphonesimulator.app',
      './test/assets/Library',
    ])
    .pipe(gulp.dest('./build/test/assets/')),
);

boilerplate({
  build: 'appium-ios-simulator',
  coverage: {
    files: ['./build/test/unit/**/*-specs.js'],
    verbose: true,
  },
  postTranspile: ['copy-files-for-build']
});
