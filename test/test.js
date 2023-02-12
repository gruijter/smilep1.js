/* eslint-disable prefer-destructuring */
/* eslint-disable no-console */
/* This Source Code Form is subject to the terms of the Mozilla Public
	License, v. 2.0. If a copy of the MPL was not distributed with this
	file, You can obtain one at http://mozilla.org/MPL/2.0/.

	Copyright 2016 - 2023, Robin de Gruijter <gruijter@hotmail.com> */

// INSTRUCTIONS FOR TESTING FROM DESKTOP:
// install node (https://nodejs.org)
// install this package: > npm i smilep1
// run the test (from the install folder): > npm test id=yourSmileID

'use strict';

const _test = require('./_test');

console.log('Testing now. Hang on.....');

const getOptions = () => {
	const options = {};
	const args = process.argv.slice(2);
	Object.keys(args).forEach((arg) => {
		const info = args[arg].split(/=+/g);
		if (info.length === 2) {
			options[info[0]] = info[1].replace(/['"]+/g, '');
		}
	});

	if (Object.keys(options).length === 0) {
		options.id = process.argv[2];
		options.host = process.argv[3];
		options.port = process.argv[4];
	}

	if (options.port) {
		options.port = Number(options.port);
	}

	// if (options.tls) {
	// 	options.tls = options.tls.toLowerCase() === 'true';
	// }

	if (options.reversed && options.reversed !== 'false') options.reversed = true;
	return options;
};

const test = async () => {
	try {
		const options = await getOptions();
		const log = await _test.test(options);
		for (let i = 0; i < (log.length); i += 1) {
			console.log(log[i]);
		}
	} catch (error) { console.log(error); }
};

test();
