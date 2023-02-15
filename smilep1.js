/* eslint-disable prefer-destructuring */
/* This Source Code Form is subject to the terms of the Mozilla Public
	License, v. 2.0. If a copy of the MPL was not distributed with this
	file, You can obtain one at http://mozilla.org/MPL/2.0/.

	Copyright 2016 - 2023, Robin de Gruijter <gruijter@hotmail.com> */

'use strict';

const parseXml = require('xml-js');
const http = require('http');
const https = require('https');
// const util = require('util');

// v2 and v3 firmware
const modulesPath = '/core/modules';
const objectsPath = '/core/direct_objects';
const logsPath = '/core/locations/logs';

// const domainObjectsPath = '/core/domain_objects';
// const enumerationPath = '/core/enumerations';

// v2 firmware only:
const statusPath = '/system/status/xml';
// const licensePath = '/license';
// const timePath = '/configuration/time';
// const updateFirmwarePath = '/update/firmware';
// const wifiPath = '/configuration/wifi';
// const networkPath = '/configuration/network'

// v3 firmware only:
const gatewayPath = '/core/domain_objects;class=Gateway'; // class=Module Appliance Location
// const servicesPath = '/core/modules;class=Services';
const discoveryPath = '/proxy/auth/announce'; // 'https://connect.plugwise.net/proxy/auth/announce/SMILEID.json?_=1563626014476'
const networkScanPath = '/core/gateways/network;@scan';
const interfaceStatusPath = '/core/gateways/network';
const rebootPath = '/core/gateways;@reboot';

const defaultHost = 'connect.plugwise.net';
const defaultPort = 80;
const defaultTimeout = 10000;

const regexMeasurePower = /unit='W' directionality='consumed'>(.*?)<\/measurement>/;
const regexMeasurePowerProduced = /unit='W' directionality='produced'>(.*?)<\/measurement>/;
const regexPowerPeak = /unit='Wh' directionality='consumed' tariff_indicator='nl_peak'>(.*?)<\/measurement>/;
const regexPowerOffpeak = /unit='Wh' directionality='consumed' tariff_indicator='nl_offpeak'>(.*?)<\/measurement>/;
const regexPowerPeakProduced = /unit='Wh' directionality='produced' tariff_indicator='nl_peak'>(.*?)<\/measurement>/;
const regexPowerOffpeakProduced = /unit='Wh' directionality='produced' tariff_indicator='nl_offpeak'>(.*?)<\/measurement>/;
const regexGas = /unit='m3' directionality='consumed'>(.*?)<\/measurement>/;
const regexPowerTm = /<measurement log_date='(.*?)' unit='Wh' directionality='consumed' tariff_indicator='nl_offpeak'>/;
const regexGasTm = /<measurement log_date='(.*?)' unit='m3' directionality='consumed'>/;
const regexFwLevel2 = /<version>(.*?)<\/version>/;
const regexFwLevel3 = /<firmware_version>(.*?)<\/firmware_version>/;

const flatten = async (json, level) => {
	try {
		const lvl = level ? level + 1 : 1;
		if (lvl > 10) return json;
		const flat = {};
		Object.keys(json).forEach(async (key) => {
			if (key === '_attributes') {
				Object.keys(json[key]).forEach((attr) => {
					flat[attr] = json[key][attr];
				});
				return;
			}
			flat[key] = json[key];
			if (Object.keys(json[key]).length === 0) {
				flat[key] = undefined;
				if (key === '_text') {
					delete flat[key];
					flat.value = json[key];
				}
				return;
			}
			if (Object.keys(json[key]).length === 1) {
				if (Object.prototype.hasOwnProperty.call(json[key], '_text')) {
					flat[key] = json[key]._text;
				} else {
					flat[key] = await flatten(json[key], lvl);
				}
				return;
			}
			flat[key] = await flatten(json[key], lvl);
		});
		return Promise.resolve(flat);
	} catch (error) {
		return Promise.reject(error);
	}
};

class SmileP1 {
	// Represents a session to a Plugwise Smile P1 device.
	constructor(opts) {	// id, host, port, timeout, meterMethod
		const options = opts || {};
		this.id = options.id;
		this.host = options.host || defaultHost;
		this.port = options.port || defaultPort;
		this.timeout = options.timeout || defaultTimeout;
		this.loggedIn = true;
		this.reversed = !!options.reversed; // for Belgian meters. Default is false.
		this.firmwareLevel = undefined;
		this.meterMethod = options.meterMethod;	// force 1 for fw2, or 2 for fw 3. Will be automaically determined if undefined
		this.lastResponse = undefined;
	}

	/**
	* Login to the Smile P1. Passing options will override any existing session settings.
	* @param {sessionOptions} [options] - configurable session options
	* @returns {Promise.<loggedIn>} The loggedIn state.
	*/
	async login(opts) {
		try {
			const options = opts || {};
			this.id = options.id || this.id;
			this.host = options.host || this.host;
			this.port = options.port || this.port;
			this.timeout = options.timeout || this.timeout;
			this.reversed = Object.prototype.hasOwnProperty.call(options, 'reversed') ? options.reversed : this.reversed;
			// get IP address when using connect.plugwise.net
			if (!this.host || this.host === defaultHost) {
				await this.discover();
			}
			await this.getFirmwareLevel();
			this.loggedIn = true;
			return Promise.resolve(this.loggedIn);
		} catch (error) {
			this.loggedIn = false;
			return Promise.reject(error);
		}
	}

	/**
	* Discover a Plugwise device in your local network (internet connection required)
	* @param {discoverOptions} [options] - configurable discovery options
 	* @returns {Promise.<discoverInfo>} The device information.
	*/
	async discover(opts) {
		try {
			const opts2 = opts || {};
			const id = opts2.id || this.id;
			const postMessage = '';
			const headers = {
				'cache-control': 'no-cache',
				'user-agent': 'node-smilep1js',
				'content-length': Buffer.byteLength(postMessage),
				connection: 'Keep-Alive',
			};
			const options = {
				hostname: defaultHost,
				port: 443,
				path: `${discoveryPath}/${id}.json`,
				headers,
				method: 'GET',
			};
			const result = await this._makeHttpsRequest(options, postMessage);
			if (result.statusCode === 404) {
				throw Error('Discovery failed possibly due to incorrect ID.');
			}
			if (result.statusCode !== 200 && result.statusCode) {
				this.lastResponse = result.statusCode;
				throw Error(`Discovery Failed. Status Code: ${result.statusCode}`);
			}
			const contentType = result.headers['content-type'];
			if (!/^application\/json/.test(contentType)) {
				throw Error(`Discovery failed. Expected application/json but received ${contentType}`);
			}
			const info = JSON.parse(result.body);
			this.host = info.lan_ip || info.wifi_ip;
			return Promise.resolve(info);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Get firmware level of the Smile P1 device.
	* @returns {Promise.<firmwareLevel>} The status information.
	*/
	async getFirmwareLevel() {
		try {
			// try for fw 3
			const result = await this._makeRequest(gatewayPath, true);
			const fw = regexFwLevel3.exec(result);
			if (Array.isArray(fw)) {
				this.firmwareLevel = fw[1];
			} else {	// try for fw 2
				const result2 = await this._makeRequest(statusPath, true);
				const fw2 = regexFwLevel2.exec(result2);
				if (Array.isArray(fw2)) {
					this.firmwareLevel = fw2[1];
				}
			}
			return Promise.resolve(this.firmwareLevel);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Get the deviceInfo. The returned device info depends on fw level
	* @returns {(Promise.<statusV2>|Promise.<statusV3>)} The device info depends on fw level
	*/
	async getStatus() {
		try {
			let status = {};
			if (typeof this.firmwareLevel === 'string') {
				if (this.firmwareLevel[0] >= 3) {
					status = await this._getStatusV3();
				} else { status = await this._getStatusV2(); }
			}
			return Promise.resolve(status);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Get the network interface status. (V3 firmware only)
	* @returns {Promise.<interfaceStatus>}
	*/
	async getInterfaceStatus() {
		try {
			const result = await this._makeRequest(interfaceStatusPath);
			// parse xml to json object
			const parseOptions = {
				compact: true, nativeType: true, ignoreDeclaration: true, // ignoreAttributes: true, // spaces: 2,
			};
			const json = parseXml.xml2js(result, parseOptions);
			const raw = json.gateways.gateway.interfaces.interface;
			const info = await flatten(raw);
			const interfaceStatus = {};
			Object.keys(info).forEach((key) => {
				interfaceStatus[`${info[key].name}`] = info[key];
			});
			return Promise.resolve(interfaceStatus);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Perform a wifi scan. (V3 firmware only)
	* @returns {Promise.<WifiScanInfo>}
	*/
	async getWifiScan() {
		try {
			const result = await this._makeRequest(networkScanPath, false, 15000);
			// parse xml to json object
			const parseOptions = {
				compact: true, nativeType: true, ignoreDeclaration: true, // ignoreAttributes: true, // spaces: 2,
			};
			const json = parseXml.xml2js(result, parseOptions);
			const raw = json.gateways.gateway.interfaces.interface['1'].networks.network;
			const info = await flatten(raw);
			const wifiScanInfo = [];
			Object.keys(info).forEach((key) => {
				const ap = {
					ssid: info[key].ssid,
				};
				wifiScanInfo.push(Object.assign(ap, info[key].access_points.access_point));
			});
			return Promise.resolve(wifiScanInfo);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Get the power  and gas meter readings.
	* @returns {Promise<meterReadings>}
	*/
	async getMeterReadings() {
		try {
			if (!this.meterMethod) {
				await this._getMeterMethod();
			}
			let readings = {};
			// method 1 for fw 2
			if (this.meterMethod === 1) {
				readings = await this._getMeterReadings1();
			} else {	// method 2 as default
				readings = await this._getMeterReadings2();
			}
			return Promise.resolve(readings);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Get the power and gas log history.
	* @param {logsOptions} [options] - configurable Logs options
	* @returns {Promise<meterLogs>}
	*/
	async getLogs(opts) {
		try {
			const options = opts || {};
			let path = logsPath;

			const today = new Date(new Date().setHours(0, 0, 0, 0));
			const toDefault = JSON.stringify(today).replace(/"/g, '');
			const startMonth = new Date(today.setDate(1));
			const fromDefault = JSON.stringify(startMonth).replace(/"/g, '');

			const logClass = options.logFunctionality || 'IntervalLogFunctionality';
			const type = options.type || 'electricity_consumed';
			const typeString = type ? `type=${type}` : '';
			const from = options.from || fromDefault;
			const to = options.to || toDefault;
			const interval = options.interval || 'P1D'; // 'PT1H'; // e.g. 'PT1H' or 'PT15M' or 'PT300S' etc.
			path = `${path};class:eq:${logClass};${typeString};@from=${from};@to=${to};@interval=${interval}`;
			const result = await this._makeRequest(path);
			// parse xml to json object
			const parseOptions = {
				compact: true, nativeType: true, ignoreDeclaration: true, // ignoreAttributes: true, // spaces: 2,
			};
			const json = parseXml.xml2js(result, parseOptions);
			const raw = json.locations.location.logs;
			const logs = await flatten(raw);
			return Promise.resolve(logs);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Reboot to the Smile P1. (V3 firmware only)
	* @returns {Promise.<rebootStarted>} The rebooted state.
	*/
	async reboot() {
		try {
			const actionPath = rebootPath;
			const postMessage = '';
			const headers = {
				'cache-control': 'no-cache',
				'user-agent': 'node-smilep1js',
				// 'content-type': 'multipart/form-data',
				'content-length': Buffer.byteLength(postMessage),
				connection: 'Keep-Alive',
			};
			const options = {
				hostname: this.host,
				port: this.port,
				path: actionPath,
				auth: `smile:${this.id}`,
				headers,
				method: 'POST',
			};
			let result;
			if (options.port === 443) {
				result = await this._makeHttpsRequest(options, postMessage);
			} else {
				result = await this._makeHttpRequest(options, postMessage);
			}
			if (!result.headers || !JSON.stringify(result.headers).includes('Plugwise')) {
				throw Error('reboot failed');
			}
			this.loggedIn = false;
			return Promise.resolve(true);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// /**
	// * Get status V2 information of the Smile P1 device. (V2 firmware only)
	// * @returns {Promise.<statusV2>} The status information.
	// */
	async _getStatusV2() {
		try {
			const result = await this._makeRequest(statusPath);
			// parse xml to json object
			const parseOptions = {
				compact: true, nativeType: true, ignoreDeclaration: true, // spaces: 2,
			};
			const { status } = parseXml.xml2js(result, parseOptions);
			const state = {};
			Object.keys(status).forEach((key) => {
				state[key] = {};
				Object.keys(status[key]).forEach((sub) => {
					state[key][sub] = status[key][sub]._text;
				});
			});
			return Promise.resolve(state);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// /**
	// * Get status V3 information of the Smile P1 device. (V3 firmware only)
	// * @returns {Promise.<statusV3>} The status information.
	// */
	async _getStatusV3() {
		try {
			const result = await this._makeRequest(gatewayPath, true);
			// parse xml to json object
			const parseOptions = {
				compact: true, nativeType: true, ignoreDeclaration: true, // ignoreAttributes: true, // spaces: 2,
			};
			const json = parseXml.xml2js(result, parseOptions);
			const raw = json.domain_objects.gateway;
			const state = await flatten(raw);
			return Promise.resolve(state);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// /**
	// * Get the meterMethod. Returns 1 for firmware below 3, returns 2 otherwise
	// * @returns {Promise.<meterMethod>} The meter Method.
	// */
	async _getMeterMethod() {
		try {
			await this.getFirmwareLevel();
			if (typeof this.firmwareLevel === 'string') {
				if (this.firmwareLevel[0] <= 2) {
					this.meterMethod = 1;
				} else { this.meterMethod = 2; }
			}
			return Promise.resolve(this.meterMethod);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async _getMeterReadings1() {
		try {
			const result = await this._makeRequest(modulesPath);
			const readings = {};
			try {
				const measurePower = Number(regexMeasurePower.exec(result)[1]);
				const measurePowerProduced = Number(regexMeasurePowerProduced.exec(result)[1]);
				const powerPeak = Number(regexPowerPeak.exec(result)[1]) / 1000;
				const powerOffpeak = Number(regexPowerOffpeak.exec(result)[1]) / 1000;
				const powerPeakProduced = Number(regexPowerPeakProduced.exec(result)[1]) / 1000;
				const powerOffpeakProduced = Number(regexPowerOffpeakProduced.exec(result)[1]) / 1000;
				const powerTm = Date.parse(regexPowerTm.exec(result)[1]) / 1000;
				readings.pwr = measurePower - measurePowerProduced;
				readings.net = Math.round(10000 * (powerPeak + powerOffpeak - powerPeakProduced - powerOffpeakProduced)) / 10000;
				readings.p2 = powerPeak;
				readings.p1 = powerOffpeak;
				readings.n2 = powerPeakProduced;
				readings.n1 = powerOffpeakProduced;
				readings.tm = powerTm;
			} catch (err) {
				// console.log('Error parsing power information, or no power readings available');
			}
			try {
				const gas = Number(regexGas.exec(result)[1]);
				const gasTm = Date.parse(regexGasTm.exec(result)[1]) / 1000;
				readings.gas = gas;
				readings.gtm = gasTm;
			} catch (err) {
				// console.log('Error parsing gas information, or no gas readings available');
			}
			if (!readings.tm && !readings.gtm) {
				throw Error('Error parsing meter info');
			}
			if (this.reversed) {
				const tmp = { ...readings };
				readings.p1 = tmp.p2;
				readings.p2 = tmp.p1;
				readings.n1 = tmp.n2;
				readings.n2 = tmp.n1;
			}
			return Promise.resolve(readings);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async _getMeterReadings2() {
		try {
			const readings = {};
			let measurePower = 0;
			let measurePowerProduced = 0;
			let powerPeak = 0;
			let powerOffpeak = 0;
			let powerPeakProduced = 0;
			let powerOffpeakProduced = 0;
			let powerTm = '0';
			let gas = 0;
			let gasTm = '0';
			let l1c;
			let l1p;
			let l2c;
			let l2p;
			let l3c;
			let l3p;
			let v1;
			let v2;
			let v3;
			const result = await this._makeRequest(objectsPath);
			// parse xml to json object
			const parseOptions = {
				compact: true, nativeType: true, ignoreDeclaration: true, // spaces: 2,
			};
			const json = parseXml.xml2js(result, parseOptions);
			const logs = json.direct_objects.location.logs;
			logs.cumulative_log.forEach((log) => {
				if (log.type._text === 'electricity_consumed') {
					powerOffpeak = log.period.measurement.filter((m) => (m._attributes.tariff_indicator === 'nl_offpeak'
						|| m._attributes.tariff === 'nl_offpeak'))[0]._text / 1000;
					powerPeak = log.period.measurement.filter((m) => (m._attributes.tariff_indicator === 'nl_peak'
					|| m._attributes.tariff === 'nl_peak'))[0]._text / 1000;
					powerTm = log.updated_date._text;	// e.g. '2019-02-03T12:00:00+01:00'
				}
				if (log.type._text === 'electricity_produced') {
					powerOffpeakProduced = log.period.measurement.filter((m) => (m._attributes.tariff_indicator === 'nl_offpeak'
					|| m._attributes.tariff === 'nl_offpeak'))[0]._text / 1000;
					powerPeakProduced = log.period.measurement.filter((m) => (m._attributes.tariff_indicator === 'nl_peak'
					|| m._attributes.tariff === 'nl_peak'))[0]._text / 1000;
				}
				if (log.type._text === 'gas_consumed') {
					gas = log.period.measurement._text;	// gas
					gasTm = log.updated_date._text;	// e.g. '2019-02-03T12:00:00+01:00'
				}
			});
			logs.point_log.forEach((log) => {
				if (log.type._text === 'voltage_phase_one') {
					v1 = log.period.measurement._text;
				}
				if (log.type._text === 'voltage_phase_two') {
					v2 = log.period.measurement._text;
				}
				if (log.type._text === 'voltage_phase_three') {
					v3 = log.period.measurement._text;
				}
				if (log.type._text === 'electricity_phase_one_consumed') {
					l1c = log.period.measurement._text;
				}
				if (log.type._text === 'electricity_phase_one_produced') {
					l1p = log.period.measurement._text;
				}
				if (log.type._text === 'electricity_phase_two_consumed') {
					l2c = log.period.measurement._text;
				}
				if (log.type._text === 'electricity_phase_two_produced') {
					l2p = log.period.measurement._text;
				}
				if (log.type._text === 'electricity_phase_three_consumed') {
					l3c = log.period.measurement._text;
				}
				if (log.type._text === 'electricity_phase_three_produced') {
					l3p = log.period.measurement._text;
				}
				if (log.type._text === 'electricity_consumed') {
					if (Array.isArray(log.period.measurement)) {
						measurePower = log.period.measurement[1]._text + log.period.measurement[0]._text; // 0=peak, 1=offPeak, or vice versa
					} else { measurePower = log.period.measurement._text; }
					// const powerTm = log.updated_date._text;	// e.g. '2019-02-03T12:03:18+01:00'
					// readings.tm = Date.parse(new Date(powerTm));
				}
				if (log.type._text === 'electricity_produced') {
					if (Array.isArray(log.period.measurement)) {
						measurePowerProduced = log.period.measurement[1]._text + log.period.measurement[0]._text;
					} else { measurePowerProduced = log.period.measurement._text; }
					// const powerTm = log.updated_date._text;	// e.g. '2019-02-03T12:03:18+01:00'
					// readings.tm = Date.parse(new Date(powerTm));
				}
			});
			readings.pwr = measurePower - measurePowerProduced;
			readings.l1 = l1c - l1p;
			readings.l2 = l2c - l2p;
			readings.l3 = l3c - l3p;
			readings.v1 = v1;
			readings.v2 = v2;
			readings.v3 = v3;
			readings.i1 = Math.round(100 * (readings.l1 / v1)) / 100;
			readings.i2 = Math.round(100 * (readings.l2 / v2)) / 100;
			readings.i3 = Math.round(100 * (readings.l3 / v3)) / 100;
			readings.net = Math.round(10000 * (powerPeak + powerOffpeak - powerPeakProduced - powerOffpeakProduced)) / 10000;
			readings.p2 = powerPeak;
			readings.p1 = powerOffpeak;
			readings.n2 = powerPeakProduced;
			readings.n1 = powerOffpeakProduced;
			readings.tm = Date.parse(new Date(powerTm)) / 1000;
			readings.gas = gas;
			readings.gtm = Date.parse(new Date(gasTm)) / 1000;
			if (this.reversed) {
				const tmp = { ...readings };
				readings.p1 = tmp.p2;
				readings.p2 = tmp.p1;
				readings.n1 = tmp.n2;
				readings.n2 = tmp.n1;
			}
			return Promise.resolve(readings);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async _makeRequest(actionPath, force, timeout) {
		try {
			if (!this.loggedIn && !force) {
				return Promise.reject(Error('Not logged in'));
			}
			const postMessage = '';
			const headers = {
				'cache-control': 'no-cache',
				'user-agent': 'node-smilep1js',
				// 'content-type': 'multipart/form-data',
				'content-length': Buffer.byteLength(postMessage),
				connection: 'Keep-Alive',
			};
			const options = {
				hostname: this.host,
				port: this.port,
				path: actionPath,
				auth: `smile:${this.id}`,
				headers,
				method: 'GET',
			};
			let result;
			if (options.port === 443) {
				result = await this._makeHttpsRequest(options, postMessage, timeout);
			} else {
				result = await this._makeHttpRequest(options, postMessage, timeout);
			}
			this.lastResponse = result.body;
			if (result.headers['set-cookie']) {
				this.cookie = result.headers['set-cookie'];
			}
			if (result.statusCode === 401) {
				this.lastResponse = result.statusCode;
				throw Error('401 Unauthorized (wrong smileId or wrong IP)');
			}
			if (result.statusCode !== 200 && result.statusCode) {
				this.lastResponse = result.statusCode;
				throw Error(`HTTP request Failed. Status Code: ${result.statusCode}`);
			}
			const contentType = result.headers['content-type'];
			if (!/^text\//.test(contentType)) {
				throw Error(`Invalid content-type. Expected text/xml or text/html but received ${contentType}`);
			}
			return Promise.resolve(result.body);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	_makeHttpRequest(options, postData, timeout) {
		return new Promise((resolve, reject) => {
			const opts = options;
			opts.timeout = timeout || this.timeout;
			const req = http.request(opts, (res) => {
				let resBody = '';
				res.on('data', (chunk) => {
					resBody += chunk;
				});
				res.once('end', () => {
					this.lastResponse = resBody;
					if (!res.complete) {
						return reject(Error('The connection was terminated while the message was still being sent'));
					}
					res.body = resBody;
					return resolve(res);
				});
			});
			req.on('error', (e) => {
				req.destroy();
				this.lastResponse = e;
				return reject(e);
			});
			req.on('timeout', () => {
				req.destroy();
			});
			req.end(postData);
		});
	}

	_makeHttpsRequest(options, postData, timeout) {
		return new Promise((resolve, reject) => {
			const opts = options;
			opts.timeout = timeout || this.timeout;
			const req = https.request(opts, (res) => {
				let resBody = '';
				res.on('data', (chunk) => {
					resBody += chunk;
				});
				res.once('end', () => {
					this.lastResponse = resBody;
					if (!res.complete) {
						return reject(Error('The connection was terminated while the message was still being sent'));
					}
					res.body = resBody;
					return resolve(res);
				});
			});
			req.on('error', (e) => {
				req.destroy();
				this.lastResponse = e;
				return reject(e);
			});
			req.on('timeout', () => {
				req.destroy();
			});
			req.end(postData);
		});
	}

}

module.exports = SmileP1;

// definitions for JSDoc

/**
* @class SmileP1
* @classdesc Class representing a session with a Smile P1 device.
* @param {sessionOptions} [options] - configurable session options
* @property {boolean} loggedIn - login state.
* @property {number} firmwareLevel - firmware level of the Smile P1. e.g. '2.1.13'

* @example // create a Smile P1 session, login to device, fetch meter readings
	const Smile = require('smilep1');

	const smile = new Smile();

	async function getMeterReadings() {
		try {
			// fill in the id of the device, e.g. 'hcfrasde'
			// fill in the ip address of the device, e.g. '192.168.1.50'
			const options = { id='yourDeviceID', host='yourDeviceIP'}
			await smile.login(options);
			const powerInfo = await smile.getMeterReadings();
			console.log(powerInfo);
		} catch (error) {
			console.log(error);
		}
	}

	getMeterReadings();
*/

/**
* @typedef sessionOptions
* @description Set of configurable options to set on the router class
* @property {string} id - The short ID of the Smile P1.
* @property {string} host - The url or ip address of the Smile P1.
* @property {number} [port = 80] - The port of the Smile P1. Defaults to 80. TLS/SSL will be used when setting port to 443.
* @property {number} [timeout = 10000] - http(s) timeout in milliseconds. Defaults to 10000ms.
 @property {boolean} [reversed = false] - Reverse the peak and offPeak meters. Required in Belgium.
* @property {number} [meterMethod] - 1 for fw2, 2 for fw 3. Will be automaically determined if undefined.
* @example // session options
{ id: 'hcfrasde',
  host:'192.168.1.50',
  port: 443,
  timeout: 5000 }
*/

/**
* @typedef discoverOptions
* @description Set of configurable options to use during discovery
* @property {string} id - The short ID of the Smile P1.
* @example // discovery options
{ id: 'hcfrasde' }
*/

/**
* @typedef logsOptions
* @description Set of configurable options to use during logs retrieval
* @property {string} [from] - start of logs in zulu time '2019-07-01T22:00:00.000Z'. Defaults to this month.
* @property {string} [to] - end of logs in zulu time '2019-07-31T22:00:00.000Z'. Defaults to this month.
* @property {string} [type = 'electricity_consumed'] - meter type(s) to include e.g. 'electricity_consumed,electricity_produced,gas_consumed'.
* @property {string} [interval = 'P1D'] - interval of logs e.g. 'P1D', 'PT1H','PT15M' or 'PT300S'. Defaults to 1 day ('P1D').
* @property {string} [logClass = 'IntervalLogFunctionality'] - class(es) to include e.g. 'IntervalLogFunctionality,CumulativeLogFunctionality,PointLogFunctionality'
* @example // logs retrieval options
{ from: '2019-07-20T22:00:00.000Z',
  to: '2019-07-21T22:00:00.000Z',
  type: 'electricity_consumed,electricity_produced'},
  interval: 'PT5M',
  logClass: 'IntervalLogFunctionality, PointLogFunctionality'
}
*/

/**
* @typedef meterReadings
* @description meterReadings is an object containing power and gas information.
* @property {number} pwr power consumption total in Watt. e.g. 3030
* @property {number} l1 phase 1 power (Watt), e.g. 1129
* @property {number} l2 phase 2 power (Watt), e.g. 1129
* @property {number} l3 phase 3 power (Watt), e.g. 1129
* @property {number} v1 phase 1 voltage (Volt), e.g. 238
* @property {number} v2 phase 2 voltage (Volt), e.g. 238
* @property {number} v3 phase 3 voltage (Volt), e.g. 238
* @property {number} i1 phase 1 current (Ampere), e.g. 5.01
* @property {number} i2 phase 2 current (Ampere), e.g. 5.01
* @property {number} i3 phase 3 current (Ampere), e.g. 5.01
* @property {number} net energy meter total (consumption - production) in kWh. e.g. 7507.336
* @property {number} p2 P2 consumption counter (high tariff). e.g. 896.812
* @property {number} p1 P1 consumption counter (low tariff). e.g. 16110.964
* @property {number} n2 N2 production counter (high tariff). e.g. 4250.32
* @property {number} n1 N1 production counter (low tariff). e.g. 1570.936
* @property {number} tm time of retrieving info. unix-time-format. e.g. 1542575626
* @property {number} gas counter gas-meter (in m^3). e.g. 6161.243
* @property {number} gtm time of the last gas measurement. unix-time-format. e.g. 1542574800
* @example // meterReadings
{
  pwr: -437,
  l1: -83,
  l2: -117,
  l3: -236,
  v1: 237,
  v2: 233,
  v3: 239,
  i1: -0.35,
  i2: -0.5,
  i3: -0.99,
  net: -6131.015,
  p2: 5000.127,
  p1: 9086.173,
  n2: 13660.827,
  n1: 6556.488,
  tm: 1676472900,
  gas: 4129.74,
  gtm: 1659171300
}
*/

/**
* @typedef statusV2
* @description statusV2 is an object containing Smile P1 device information. Note: Only for V2 firmware!
* @property {object} statusV2 Object containing system information
* @example // status
{ system:
   { product: 'smile',
     mode: 'p1',
     version: '2.1.13',
     kernel: 'Linux 3.8.11, May 19 14:10:38 CEST 2016',
     date: '2019-06-14T10:34:21+0200',
     uptime: ' 7:23,  load average: 0.14, 0.19, 0.22' },
  application:
   { p1_logger: 'running',
     last_telegram: ' CEST',
     last_parse_time: 'Tue Jun 11 23:06:38 2019 CEST' },
  network:
   { hostname: 'smile7ac5b6',
     type: 'WiFi (wireless)',
     ip_address: '192.168.1.2',
     mac_address: '78:25:42:7A:B5:B1',
     ssid: 'MyWifi',
     mode: 'sta',
     link_quality: -35 } }
*/

/**
* @typedef statusV3
* @description statusV3 is an object containing Smile P1 device information. Note: Only for V3 firmware!
* @property {object} statusV3 Object containing system information
* @example // status
{ id: '48ac7095f50c4cf19fdfe7d1b66f99ae',
  created_date: '2019-07-01T08:18:25.458+02:00',
  modified_date: '2019-07-20T13:58:01.642+02:00',
  deleted_date: undefined,
  name: undefined,
  description: undefined,
  enabled: true,
  firmware_locked: false,
  prevent_default_update: false,
  last_reset_date: '2019-07-01T08:18:25.458+02:00',
  last_boot_date: '2019-07-20T13:48:20.466+02:00',
  vendor_name: 'Plugwise',
  vendor_model: 'smile',
  hardware_version: 'AME Smile 2.0 board',
  firmware_version: '3.3.6',
  mac_address: 'C49300062A32',
  short_id: 'hcfrasde',
  send_data: true,
  anonymous: false,
  lan_ip: undefined,
  wifi_ip: '192.168.1.2',
  hostname: 'smile082d76',
  time: '2019-07-20T13:58:05+02:00',
  timezone: 'Europe/Amsterdam',
  ssh_relay: 'disabled',
  project:
   { id: '123306def5eb4172ae74435aea21e753',
     name: '-- Stock',
     description: 'Stock which was previously called fulfillment',
     is_default: false,
     visible_in_production: true,
     deleted_date: undefined,
     modified_date: '2019-07-20T13:32:44.070+02:00',
     created_date: '2014-11-19T17:45:10+01:00' },
  gateway_environment:
   { id: '00ab027855a44586845028294226da06',
     savings_result_value: undefined,
     longitude: undefined,
     thermostat_model: undefined,
     city: undefined,
     country: undefined,
     electricity_consumption_tariff_structure: undefined,
     electricity_production_peak_tariff: undefined,
     central_heating_model: undefined,
     household_children: 0,
     thermostat_brand: undefined,
     electricity_production_off_peak_tariff: undefined,
     central_heating_installation_date: undefined,
     postal_code: undefined,
     electricity_consumption_off_peak_tariff: undefined,
     latitude: undefined,
     gas_consumption_tariff: undefined,
     modified_date:
      { '0': '2019-07-20T13:32:50.059+02:00',
        '1': '2019-07-20T13:32:50.059+02:00' },
     electricity_production_tariff_structure: undefined,
     housing_construction_period: 'unknown',
     electricity_production_single_tariff: undefined,
     electricity_consumption_peak_tariff: undefined,
     electricity_consumption_single_tariff: undefined,
     central_heating_brand: undefined,
     housing_type: 'apartment',
     currency: 'EUR',
     savings_result_unit: undefined,
     household_adults: 0,
     central_heating_year_of_manufacture: undefined,
     deleted_date: undefined,
     created_date: '2019-07-01T08:07:56+02:00' },
  features:
   { remote_control:
      { id: '15f73deb7f6e49df8b2510b816997165',
        activation_date: '2019-07-03T08:59:26+02:00',
        validity_period: undefined,
        valid_to: undefined,
        valid_from: undefined,
        grace_period: undefined,
        deleted_date: undefined,
        modified_date: '2019-07-20T13:32:44.111+02:00',
        created_date: '2019-07-03T08:59:26+02:00' } } }
*/

/**
* @typedef discoverInfo
* @description discoverInfo is an object containing Smile P1 device information.
* @property {object} discoverInfo Object containing system information
* @example // status
{ product: 'smile',
  version: '3.3.6',
  lan_ip: '',
  wifi_ip: '192.168.1.2',
  timestamp: '2019-07-20T14:58:38+02:00',
  zoneinfo: '',
  rest_root: '/',
  server_timestamp: '2019-07-20T12:58:38+00:00' }
*/

/**
* @typedef interfaceStatus
* @description interfaceStatus is an object containing network interface information. Note: Only for V3 firmware!
* @property {object} interfaceStatus Object containing interface information
* @example // status
{ eth0:
	{ type: 'lan', name: 'eth0', mac: '7825427AB576', state: 'down' },
   wlan0:
	{ type: 'wlan',
	  name: 'wlan0',
	  power: { unit: 'dBm', value: 21 },
	  rate: { unit: 'Mb/s', value: 58.5 },
	  standard: '802.11bgn',
	  mac: '7825427AB5B1',
	  encryption: 'wpa2-psk',
	  mode: 'client',
	  proto: 'dhcp',
	  mask: '255.255.255.0',
	  noise: { unit: 'dBm', value: -95 },
	  gway: '192.168.1.1',
	  ssid: 'MyWifi',
	  channel_width: { unit: 'MHz', value: 20 },
	  bcast: '192.168.1.255',
	  signal_strength: { unit: 'dBm', value: -60 },
	  state: 'up',
	  channel: 9,
	  link_quality: '50/70',
	  ip: '192.168.1.10',
	  frequency: { unit: 'GHz', value: 2.452 } } }
*/

/**
* @typedef wifiScanInfo
* @description wifiScanInfo is an array containing wifi station information. Note: Only for V3 firmware!
* @property {array} wifiScanInfo Array containing interface information
* @example // scanInfo
[ { ssid: 'myWifi',
    mac: '7825427AB5B1',
    encryption: 'wpa2-psk',
    quality: '63/70',
    signal_strength: { unit: 'dBm', value: -47 },
    channel: 5 },
  { ssid: 'myWifigast',
    mac: '7825427AB5EA',
    encryption: 'wpa2-psk',
    quality: '48/70',
    signal_strength: { unit: 'dBm', value: -62 },
    channel: 9 },
  { ssid: 'REMOTE85',
    mac: '001DC904DB32',
    encryption: 'wpa2-psk',
    quality: '23/70',
    signal_strength: { unit: 'dBm', value: -87 },
    channel: 3 },
  { ssid: 'GoogleHome2732.o',
    mac: 'F68FCA78294C',
    encryption: 'open',
    quality: '59/70',
    signal_strength: { unit: 'dBm', value: -51 },
    channel: 5 } ]

*/

/**
* @typedef meterLogs
* @description meterLogs is an object containing Smile P1 historic log information.
* @property {object} meterLogs Object containing logs
* @example // meterLogs
{ interval_log:
   { id: 'a17aa51dda834556905f3ea1689d18f7',
     unit: 'Wh',
     type: 'electricity_consumed',
     interval: 'PT15M',
     last_consecutive_log_date: '2019-08-24T17:45:00+02:00',
     updated_date: '2019-08-24T17:45:00+02:00',
     period:
      { start_date: '2019-07-21T00:00:00.000+02:00',
        end_date: '2019-07-21T23:00:00.000+02:00',
        interval: 'PT1H',
        measurement:
         { '0':
            { log_date: '2019-07-21T00:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 228 },
           '1':
            { log_date: '2019-07-21T01:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 214 },
           '2':
            { log_date: '2019-07-21T02:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 197 },
           '3':
            { log_date: '2019-07-21T03:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 202 },
           '4':
            { log_date: '2019-07-21T04:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 218 },
           '5':
            { log_date: '2019-07-21T05:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 196 },
           '6':
            { log_date: '2019-07-21T06:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 209 },
           '7':
            { log_date: '2019-07-21T07:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 154 },
           '8':
            { log_date: '2019-07-21T08:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 262 },
           '9':
            { log_date: '2019-07-21T09:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 38 },
           '10':
            { log_date: '2019-07-21T09:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 756 },
           '11':
            { log_date: '2019-07-21T10:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '12':
            { log_date: '2019-07-21T10:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '13':
            { log_date: '2019-07-21T11:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '14':
            { log_date: '2019-07-21T11:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '15':
            { log_date: '2019-07-21T12:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '16':
            { log_date: '2019-07-21T12:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '17':
            { log_date: '2019-07-21T13:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '18':
            { log_date: '2019-07-21T13:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '19':
            { log_date: '2019-07-21T14:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '20':
            { log_date: '2019-07-21T14:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '21':
            { log_date: '2019-07-21T15:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '22':
            { log_date: '2019-07-21T15:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '23':
            { log_date: '2019-07-21T16:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '24':
            { log_date: '2019-07-21T16:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '25':
            { log_date: '2019-07-21T17:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '26':
            { log_date: '2019-07-21T17:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '27':
            { log_date: '2019-07-21T18:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '28':
            { log_date: '2019-07-21T18:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '29':
            { log_date: '2019-07-21T19:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '30':
            { log_date: '2019-07-21T19:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 132 },
           '31':
            { log_date: '2019-07-21T20:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '32':
            { log_date: '2019-07-21T20:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '33':
            { log_date: '2019-07-21T21:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '34':
            { log_date: '2019-07-21T21:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '35':
            { log_date: '2019-07-21T22:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '36':
            { log_date: '2019-07-21T22:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 },
           '37':
            { log_date: '2019-07-21T23:00:00.000+02:00',
              tariff: 'nl_peak',
              value: 76 },
           '38':
            { log_date: '2019-07-21T23:00:00.000+02:00',
              tariff: 'nl_offpeak',
              value: 176 } } } } }
*/

/*
meter xml:
<modules>
<module id="c678caf322124cc2bd4b84c0e514b103">
<vendor_name>Xemex</vendor_name>
<vendor_model>XMX5XMXABCE000021673</vendor_model>
<hardware_version/>
<firmware_version/>
<created_date>2013-04-08T09:00:00+02:00</created_date>
<modified_date>2017-04-01T09:04:20.361+02:00</modified_date>
<deleted_date/>
<services>
<electricity_interval_meter id="1234b34867314ccb886bb72455611344">
<measurement log_date="2017-03-27T16:00:00+02:00" unit="Wh" interval="PT300S" directionality="produced" tariff_indicator="nl_offpeak">0.000</measurement>
<measurement log_date="2017-03-27T16:00:00+02:00" unit="Wh" interval="PT300S" directionality="produced" tariff_indicator="nl_peak">0.000</measurement>
<measurement log_date="2017-03-27T16:00:00+02:00" unit="Wh" interval="PT300S" directionality="consumed" tariff_indicator="nl_offpeak">0.000</measurement>
<measurement log_date="2017-03-27T16:00:00+02:00" unit="Wh" interval="PT300S" directionality="consumed" tariff_indicator="nl_peak">647.000</measurement>
</electricity_interval_meter>
<electricity_point_meter id="d33a5cf0b4eb46c2989dba87d07b2c3c">
<measurement log_date="2017-03-27T16:36:55+02:00" unit="W" directionality="produced">0.000</measurement>
<measurement log_date="2017-03-27T16:36:55+02:00" unit="W" directionality="consumed">1130.000</measurement>
</electricity_point_meter>
<electricity_cumulative_meter id="a99baa51dda834556905f3ea1689d34g5">
<measurement log_date="2017-03-27T16:35:00+02:00" unit="Wh" directionality="produced" tariff_indicator="nl_offpeak">1100755.000</measurement>
<measurement log_date="2017-03-27T16:35:00+02:00" unit="Wh" directionality="produced" tariff_indicator="nl_peak">2979339.000</measurement>
<measurement log_date="2017-03-27T16:35:00+02:00" unit="Wh" directionality="consumed" tariff_indicator="nl_offpeak">10694674.000</measurement>
<measurement log_date="2017-03-27T16:35:00+02:00" unit="Wh" directionality="consumed" tariff_indicator="nl_peak">7173526.000</measurement>
</electricity_cumulative_meter>
</services>
<protocols>
<dsmrmain id="4bb5353c44db4198bb83d446b68abc00">
<serial>98108309</serial>
<dsmrmbuses>
<dsmrgas id="g6a1aeab9f1e43e8b4e2d37b73f91234"/>
</dsmrmbuses>
</dsmrmain>
</protocols>
</module>
<module id="a11aaa16b25046baa84feaa084923a3g">
<vendor_name/>
<vendor_model/>
<hardware_version/>
<firmware_version/>
<created_date>2013-04-08T08:00:00+02:00</created_date>
<modified_date>2017-04-01T09:04:20.360+02:00</modified_date>
<deleted_date/>
<services>
<gas_interval_meter id="8b218f7016734f3cb3835e8c3a9b50c3">
<measurement log_date="2017-03-27T15:00:00+02:00" unit="m3" interval="PT1H" directionality="consumed">0.000</measurement>
</gas_interval_meter>
<gas_cumulative_meter id="22a97f7762c84cc8973a752a8126cafe">
<measurement log_date="2017-03-27T16:00:00+02:00" unit="m3" directionality="consumed">4977.361</measurement>
</gas_cumulative_meter>
</services>
<protocols>
<dsmrgas id="f3a4aeab9f1e43e8b4e2d37b73f94045">
<serial>18911001147028341</serial>
<dsmrmain id="7f31353c44db4198bb83d446b68ced45"/>
</dsmrgas>
</protocols>
</module>
</modules>

meter JSON:
{ e:
   { measurePower: 1130,
     measurePowerProduced: 0,
     powerPeak: 7173.526,
     powerOffpeak: 10694.674,
     powerPeakProduced: 2979.339,
     powerOffpeakProduced: 1100.755,
     powerTm: 1490625300000 },
  g: { gas: 4977.361, gasTm: 1490623200 }
}

firmware XML:
<update>
	<firmware>
		<current>
			<version>2.1.13</version>
		</current>
		<upgrade>
			<state>no upgrade</state>
		</upgrade>
	</firmware>
</update>

domain object DSMR5:
<?xml version="1.0" encoding="UTF-8"?>
<domain_objects>
	<module id='3f1def863355450a93dad674572a2881'>
		<vendor_name>ENERDIS</vendor_name>
		<vendor_model>T210-D ESMR5.0</vendor_model>
		<hardware_version></hardware_version>
		<firmware_version></firmware_version>
		<created_date>2019-12-28T14:24:08.766+01:00</created_date>
		<modified_date>2023-01-10T00:41:16.091+01:00</modified_date>
		<deleted_date></deleted_date>
		<services>
			<electricity_cumulative_meter id='5b42b310575d4a198827559b241639fe' log_type='electricity'>
				<functionalities><cumulative_log id='4c4ff33fe38d42169458cec9f3979fee'/><cumulative_log id='b969feb771484072bf3259374a022bfa'/></functionalities>
			</electricity_cumulative_meter>
			<voltage_meter id='71be021dc36445519186c4e2d52abd12' log_type='voltage_phase_two'>
				<functionalities><point_log id='b8bced947b2f43269e225462bdd56b1b'/></functionalities>
			</voltage_meter>
			<electricity_point_meter id='785d7619437246bbb13c5e61b8424b6b' log_type='electricity_phase_one'>
				<functionalities><point_log id='0c9e632fe1374c9f987cbe97b327bf1d'/><point_log id='2707e7f55ced481ba304dcf318b4f137'/></functionalities>
			</electricity_point_meter>
			<electricity_point_meter id='c9ded4243b2a4117b32cf1bd89edb5be' log_type='electricity_phase_two'>
				<functionalities><point_log id='0c19e799231547fb97b85934e412887c'/><point_log id='cb5991a238014cd9bc86ba3673e9155f'/></functionalities>
			</electricity_point_meter>
			<voltage_meter id='d5694b70b4724263ba1adbee244be1b9' log_type='voltage_phase_three'>
				<functionalities><point_log id='b0959d7270cd46b99c943fb6565d43ba'/></functionalities>
			</voltage_meter>
			<electricity_point_meter id='ecc28e77fbfa4f7f852998358ca1a542' log_type='electricity_phase_three'>
				<functionalities><point_log id='8b339dc41562480596579127c40f6138'/><point_log id='988b3643ed71435b8e7eb4c9aefd982a'/></functionalities>
			</electricity_point_meter>
			<voltage_meter id='ed218585ee79465b96e4f32c7dda1fe1' log_type='voltage_phase_one'>
				<functionalities><point_log id='308ce3df55804b8aa4dc5c7fba8e5a13'/></functionalities>
			</voltage_meter>
			<electricity_interval_meter id='f054c6ca90cd4b4abb210bda171c3da1' log_type='electricity'>
				<functionalities><interval_log id='2a63d6f706474ce9860e362e1fe87a72'/><interval_log id='448f2a85d91d4f60bdc16f50f569475f'/></functionalities>
			</electricity_interval_meter>
			<electricity_point_meter id='f09863d0fe8448578ad7fe36f4c818cf' log_type='electricity'>
				<functionalities><point_log id='358ef9c4f7414580a2082c4d4899a37f'/><point_log id='f2e1050669df41b6bf0d4c539edadd14'/></functionalities>
			</electricity_point_meter>
		</services>
		<protocols>
			<dsmr_main id='4192221cab3249a8a5629e61fb405b2f'>
				<serial>E0048000038005719</serial>
				<version>50</version>
				<dsmr_mbuses/>
				<telegram><![CDATA[/Ene5\T210-D ESMR5.0

1-3:0.2.8(50)
0-0:1.0.0(230215155733W)
0-0:96.1.1(4530303438303030303338303035373139)
1-0:1.8.1(009086.173*kWh)
1-0:1.8.2(005000.127*kWh)
1-0:2.8.1(006556.488*kWh)
1-0:2.8.2(013660.840*kWh)
0-0:96.14.0(0002)
1-0:1.7.0(00.000*kW)
1-0:2.7.0(00.391*kW)
0-0:96.7.21(00088)
0-0:96.7.9(00040)
1-0:99.97.0(10)(0-0:96.7.19)(220523151434S)(0000004058*s)(211109153510W)(0000001740*s)(210929162521S)(0000005207*s)
	(210903155307S)(0000001819*s)(191129101857W)(0000000426*s)(191029172333W)(0000001565*s)(191029135014W)(0000002151*s)(191018150311S)(0000000673*s)(191016153045S)(0000023958*s)(191016083319S)(0000062004*s)
1-0:32.32.0(00015)
1-0:52.32.0(00013)
1-0:72.32.0(00013)
1-0:32.36.0(00000)
1-0:52.36.0(00000)
1-0:72.36.0(00070)
0-0:96.13.0()
1-0:32.7.0(236.0*V)
1-0:52.7.0(233.0*V)
1-0:72.7.0(239.0*V)
1-0:31.7.0(001*A)
1-0:51.7.0(001*A)
1-0:71.7.0(001*A)
1-0:21.7.0(00.000*kW)
1-0:41.7.0(00.000*kW)
1-0:61.7.0(00.000*kW)
1-0:22.7.0(00.075*kW)
1-0:42.7.0(00.089*kW)
1-0:62.7.0(00.226*kW)
!1DF5
]]></telegram>
			</dsmr_main>
		</protocols>
	</module>
	<gateway id='1fa49786110c4ebb90e2fd341d7e3cdf'>
		<created_date>2019-12-28T14:21:40.385+01:00</created_date>
		<modified_date>2023-02-15T15:55:26.387+01:00</modified_date>
		<deleted_date/>
		<name></name>
		<description></description>
		<enabled>true</enabled>
		<firmware_locked>false</firmware_locked>
		<prevent_default_update>false</prevent_default_update>
		<last_reset_date>2019-12-28T14:21:40.385+01:00</last_reset_date>
		<last_boot_date>2023-01-24T14:05:53.277+01:00</last_boot_date>
		<vendor_name>Plugwise</vendor_name>
		<vendor_model>smile</vendor_model>
		<hardware_version>AME Smile 2.0 board</hardware_version>
		<firmware_version>4.4.2</firmware_version>
		<mac_address>C4930004B97E</mac_address>
		<wifi_mac_address>C4930004B97C</wifi_mac_address>
		<short_id>kqdqmscb</short_id>
		<send_data>false</send_data>
		<anonymous>false</anonymous>
		<lan_ip>10.0.0.5</lan_ip>
		<wifi_ip></wifi_ip>
		<hostname>smile04b97e</hostname>
		<time>2023-02-15T15:56:56+01:00</time>
		<timezone>Europe/Amsterdam</timezone>
		<ssh_relay>disabled</ssh_relay>
		<project id='123306def5eb4172ae74435aea21e753'>
			<name>Z -- Stock</name>
			<description>Stock which was previously called fulfillment</description>
			<is_default>false</is_default>
			<visible_in_production>true</visible_in_production>
			<deleted_date></deleted_date>
			<created_date>2014-11-19T17:45:10+01:00</created_date>
			<modified_date>2019-12-28T14:21:48.135+01:00</modified_date>
		</project>
		<gateway_environment id='2a5d97d5b8f047b29cf5c3cbd9269fc2'>
			<electricity_consumption_off_peak_tariff/>
			<electricity_production_single_tariff>0.4</electricity_production_single_tariff>
			<electricity_production_peak_tariff/>
			<electricity_production_off_peak_tariff/>
			<modified_date>2022-12-01T05:47:56.412+01:00</modified_date>
			<central_heating_year_of_manufacture/>
			<tariff_region>NL</tariff_region>
			<thermostat_brand/>
			<housing_type>apartment</housing_type>
			<housing_construction_period>unknown</housing_construction_period>
			<household_adults>0</household_adults>
			<household_children>0</household_children>
			<currency>EUR</currency>
			<savings_result_unit/>
			<savings_result_value/>
			<central_heating_brand/>
			<central_heating_model/>
			<latitude/>
			<central_heating_installation_date/>
			<longitude/>
			<thermostat_model/>
			<postal_code/>
			<city/>
			<country/>
			<electricity_consumption_tariff_structure>single</electricity_consumption_tariff_structure>
			<electricity_production_tariff_structure>single</electricity_production_tariff_structure>
			<gas_consumption_tariff>0.74</gas_consumption_tariff>
			<electricity_consumption_single_tariff>0.4</electricity_consumption_single_tariff>
			<electricity_consumption_peak_tariff/>
			<deleted_date></deleted_date>
			<created_date>2023-02-14T05:48:37+01:00</created_date>
			<modified_date>2022-12-01T05:47:56.412+01:00</modified_date>
		</gateway_environment>
		<features>
			<remote_control id='25aeb0ff533f4029b11c3f099110d3a0'>
				<grace_period/>
				<validity_period/>
				<valid_from></valid_from>
				<valid_to></valid_to>
				<activation_date>2019-11-21T16:49:49+01:00</activation_date>
				<expiration_date>2038-01-19T04:14:07+01:00</expiration_date>
				<deleted_date></deleted_date>
				<created_date>2019-11-21T16:49:49+01:00</created_date>
				<modified_date>2019-12-28T14:21:48.173+01:00</modified_date>
			</remote_control>
		</features>
	</gateway>
	<location id='46f36506f60049929aa3321b654878dc'>
		<name>Home</name>
		<description>A building with a smart meter.</description>
		<type>building</type>
		<created_date>2019-12-28T14:24:08.957+01:00</created_date>
		<modified_date>2023-02-15T15:56:56.266+01:00</modified_date>
		<deleted_date></deleted_date>
		<preset>home</preset>
		<clients/>
		<appliances/>
		<logs>
			<cumulative_log id='0c131b9382194e5aba43f8113363d5e2'>
				<type>gas_consumed</type>
				<unit>m3</unit>
				<updated_date>2022-07-30T10:55:00+02:00</updated_date>
				<last_consecutive_log_date>2022-07-30T10:55:00+02:00</last_consecutive_log_date>
				<interval/>
				<gas_cumulative_meter id='8f4af03185764157afd27218a84ace74'/>
				<period start_date="2022-07-30T10:55:00+02:00" end_date="2022-07-30T10:55:00+02:00">
					<measurement log_date="2022-07-30T10:55:00+02:00">4129.74</measurement>
				</period>
			</cumulative_log>
			<point_log id='0c19e799231547fb97b85934e412887c'>
				<type>electricity_phase_two_consumed</type>
				<unit>W</unit>
				<updated_date>2023-02-15T15:56:56+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:56+01:00</last_consecutive_log_date>
				<interval/>
				<electricity_point_meter id='c9ded4243b2a4117b32cf1bd89edb5be'/>
				<period start_date="2023-02-15T15:56:56+01:00" end_date="2023-02-15T15:56:56+01:00">
					<measurement log_date="2023-02-15T15:56:56+01:00">0.00</measurement>
				</period>
			</point_log>
			<point_log id='0c9e632fe1374c9f987cbe97b327bf1d'>
				<type>electricity_phase_one_produced</type>
				<unit>W</unit>
				<updated_date>2023-02-15T15:56:56+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:56+01:00</last_consecutive_log_date>
				<interval/>
				<electricity_point_meter id='785d7619437246bbb13c5e61b8424b6b'/>
				<period start_date="2023-02-15T15:56:56+01:00" end_date="2023-02-15T15:56:56+01:00">
					<measurement log_date="2023-02-15T15:56:56+01:00">75.00</measurement>
				</period>
			</point_log>
			<point_log id='2707e7f55ced481ba304dcf318b4f137'>
				<type>electricity_phase_one_consumed</type>
				<unit>W</unit>
				<updated_date>2023-02-15T15:56:56+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:56+01:00</last_consecutive_log_date>
				<interval/>
				<electricity_point_meter id='785d7619437246bbb13c5e61b8424b6b'/>
				<period start_date="2023-02-15T15:56:56+01:00" end_date="2023-02-15T15:56:56+01:00">
					<measurement log_date="2023-02-15T15:56:56+01:00">0.00</measurement>
				</period>
			</point_log>
			<interval_log id='2a63d6f706474ce9860e362e1fe87a72'>
				<type>electricity_consumed</type>
				<unit>Wh</unit>
				<updated_date>2023-02-15T15:55:00+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:50:00+01:00</last_consecutive_log_date>
				<interval>PT5M</interval>
				<electricity_interval_meter id='f054c6ca90cd4b4abb210bda171c3da1'/>
				<period start_date="2023-02-15T15:55:00+01:00" end_date="2023-02-15T15:55:00+01:00" interval="PT5M">
					<measurement log_date="2023-02-15T15:55:00+01:00" tariff="nl_peak">0.00</measurement>
					<measurement log_date="2023-02-15T15:55:00+01:00" tariff="nl_offpeak">0.00</measurement>
				</period>
			</interval_log>
			<point_log id='308ce3df55804b8aa4dc5c7fba8e5a13'>
				<type>voltage_phase_one</type>
				<unit>V</unit>
				<updated_date>2023-02-15T15:56:56+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:56+01:00</last_consecutive_log_date>
				<interval/>
				<voltage_meter id='ed218585ee79465b96e4f32c7dda1fe1'/>
				<period start_date="2023-02-15T15:56:56+01:00" end_date="2023-02-15T15:56:56+01:00">
					<measurement log_date="2023-02-15T15:56:56+01:00">236.00</measurement>
				</period>
			</point_log>
			<point_log id='358ef9c4f7414580a2082c4d4899a37f'>
				<type>electricity_produced</type>
				<unit>W</unit>
				<updated_date>2023-02-15T15:56:56+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:56+01:00</last_consecutive_log_date>
				<interval/>
				<electricity_point_meter id='f09863d0fe8448578ad7fe36f4c818cf'/>
				<period start_date="2023-02-15T15:56:56+01:00" end_date="2023-02-15T15:56:56+01:00">
					<measurement log_date="2023-02-15T15:56:56+01:00" tariff="nl_offpeak">0.00</measurement>
					<measurement log_date="2023-02-15T15:56:56+01:00" tariff="nl_peak">391.00</measurement>
				</period>
			</point_log>
			<interval_log id='448f2a85d91d4f60bdc16f50f569475f'>
				<type>electricity_produced</type>
				<unit>Wh</unit>
				<updated_date>2023-02-15T15:55:00+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:50:00+01:00</last_consecutive_log_date>
				<interval>PT5M</interval>
				<electricity_interval_meter id='f054c6ca90cd4b4abb210bda171c3da1'/>
				<period start_date="2023-02-15T15:55:00+01:00" end_date="2023-02-15T15:55:00+01:00" interval="PT5M">
					<measurement log_date="2023-02-15T15:55:00+01:00" tariff="nl_peak">7.00</measurement>
					<measurement log_date="2023-02-15T15:55:00+01:00" tariff="nl_offpeak">0.00</measurement>
				</period>
			</interval_log>
			<cumulative_log id='4c4ff33fe38d42169458cec9f3979fee'>
				<type>electricity_produced</type>
				<unit>Wh</unit>
				<updated_date>2023-02-15T15:56:00+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:00+01:00</last_consecutive_log_date>
				<interval/>
				<electricity_cumulative_meter id='5b42b310575d4a198827559b241639fe'/>
				<period start_date="2023-02-15T15:56:00+01:00" end_date="2023-02-15T15:56:00+01:00">
					<measurement log_date="2023-02-15T15:56:00+01:00" tariff="nl_peak">13660834.00</measurement>
					<measurement log_date="2023-02-15T15:56:00+01:00" tariff="nl_offpeak">6556488.00</measurement>
				</period>
			</cumulative_log>
			<interval_log id='60ab4470620247d7aab6ece025561ff0'>
				<type>gas_consumed</type>
				<unit>m3</unit>
				<updated_date>2022-07-30T10:00:00+02:00</updated_date>
				<last_consecutive_log_date>2022-07-30T09:00:00+02:00</last_consecutive_log_date>
				<interval>PT1H</interval>
				<gas_interval_meter id='695803fc9dd845ccb008148d266c1c2f'/>
				<period start_date="2022-07-30T10:00:00+02:00" end_date="2022-07-30T10:00:00+02:00" interval="PT1H">
					<measurement log_date="2022-07-30T10:00:00+02:00">0.00</measurement>
				</period>
			</interval_log>
			<point_log id='8b339dc41562480596579127c40f6138'>
				<type>electricity_phase_three_consumed</type>
				<unit>W</unit>
				<updated_date>2023-02-15T15:56:56+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:56+01:00</last_consecutive_log_date>
				<interval/>
				<electricity_point_meter id='ecc28e77fbfa4f7f852998358ca1a542'/>
				<period start_date="2023-02-15T15:56:56+01:00" end_date="2023-02-15T15:56:56+01:00">
					<measurement log_date="2023-02-15T15:56:56+01:00">0.00</measurement>
				</period>
			</point_log>
			<point_log id='988b3643ed71435b8e7eb4c9aefd982a'>
				<type>electricity_phase_three_produced</type>
				<unit>W</unit>
				<updated_date>2023-02-15T15:56:56+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:56+01:00</last_consecutive_log_date>
				<interval/>
				<electricity_point_meter id='ecc28e77fbfa4f7f852998358ca1a542'/>
				<period start_date="2023-02-15T15:56:56+01:00" end_date="2023-02-15T15:56:56+01:00">
					<measurement log_date="2023-02-15T15:56:56+01:00">226.00</measurement>
				</period>
			</point_log>
			<point_log id='b0959d7270cd46b99c943fb6565d43ba'>
				<type>voltage_phase_three</type>
				<unit>V</unit>
				<updated_date>2023-02-15T15:56:56+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:56+01:00</last_consecutive_log_date>
				<interval/>
				<voltage_meter id='d5694b70b4724263ba1adbee244be1b9'/>
				<period start_date="2023-02-15T15:56:56+01:00" end_date="2023-02-15T15:56:56+01:00">
					<measurement log_date="2023-02-15T15:56:56+01:00">239.00</measurement>
				</period>
			</point_log>
			<point_log id='b8bced947b2f43269e225462bdd56b1b'>
				<type>voltage_phase_two</type>
				<unit>V</unit>
				<updated_date>2023-02-15T15:56:56+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:56+01:00</last_consecutive_log_date>
				<interval/>
				<voltage_meter id='71be021dc36445519186c4e2d52abd12'/>
				<period start_date="2023-02-15T15:56:56+01:00" end_date="2023-02-15T15:56:56+01:00">
					<measurement log_date="2023-02-15T15:56:56+01:00">233.00</measurement>
				</period>
			</point_log>
			<cumulative_log id='b969feb771484072bf3259374a022bfa'>
				<type>electricity_consumed</type>
				<unit>Wh</unit>
				<updated_date>2023-02-15T15:56:00+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:00+01:00</last_consecutive_log_date>
				<interval/>
				<electricity_cumulative_meter id='5b42b310575d4a198827559b241639fe'/>
				<period start_date="2023-02-15T15:56:00+01:00" end_date="2023-02-15T15:56:00+01:00">
					<measurement log_date="2023-02-15T15:56:00+01:00" tariff="nl_peak">5000127.00</measurement>
					<measurement log_date="2023-02-15T15:56:00+01:00" tariff="nl_offpeak">9086173.00</measurement>
				</period>
			</cumulative_log>
			<point_log id='cb5991a238014cd9bc86ba3673e9155f'>
				<type>electricity_phase_two_produced</type>
				<unit>W</unit>
				<updated_date>2023-02-15T15:56:56+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:56+01:00</last_consecutive_log_date>
				<interval/>
				<electricity_point_meter id='c9ded4243b2a4117b32cf1bd89edb5be'/>
				<period start_date="2023-02-15T15:56:56+01:00" end_date="2023-02-15T15:56:56+01:00">
					<measurement log_date="2023-02-15T15:56:56+01:00">89.00</measurement>
				</period>
			</point_log>
			<point_log id='f2e1050669df41b6bf0d4c539edadd14'>
				<type>electricity_consumed</type>
				<unit>W</unit>
				<updated_date>2023-02-15T15:56:56+01:00</updated_date>
				<last_consecutive_log_date>2023-02-15T15:56:56+01:00</last_consecutive_log_date>
				<interval/>
				<electricity_point_meter id='f09863d0fe8448578ad7fe36f4c818cf'/>
				<period start_date="2023-02-15T15:56:56+01:00" end_date="2023-02-15T15:56:56+01:00">
					<measurement log_date="2023-02-15T15:56:56+01:00" tariff="nl_offpeak">0.00</measurement>
					<measurement log_date="2023-02-15T15:56:56+01:00" tariff="nl_peak">0.00</measurement>
				</period>
			</point_log>
		</logs>
		<actuator_functionalities/>
	</location>
	<module id='9e4654cd6ae04550a4673807bc41337c'>
		<vendor_name>Plugwise</vendor_name>
		<vendor_model>Gateway</vendor_model>
		<hardware_version>AME Smile 2.0 board</hardware_version>
		<firmware_version></firmware_version>
		<created_date>2019-12-28T14:21:40.581+01:00</created_date>
		<modified_date>2019-12-28T14:21:44.562+01:00</modified_date>
		<deleted_date></deleted_date>
		<services>
			<network_address id='05f5f7fd25694958a823f8e777a3ffdd' log_type='wlan_ip_address'>
				<functionalities><point_log id='3dd0223a2c564b2ba0b0adfbcb0514e5'/></functionalities>
			</network_address>
			<network_state id='2259f1b4860d44829c0f43b9ddc49993' log_type='lan_state'>
				<functionalities><point_log id='6b8cce05a46f4388ab6a86596192677a'/></functionalities>
			</network_state>
			<network_state id='4510922dfc554bf4a95eaeb33999d410' log_type='wlan_state'>
				<functionalities><point_log id='192de012c83242be8fe2c0016f16778c'/></functionalities>
			</network_state>
			<network_address id='d10b9fca32db4913a318d5b90e1b4676' log_type='lan_ip_address'>
				<functionalities><point_log id='19603566ac6a45979cf0debc1b6b31c3'/></functionalities>
			</network_address>
		</services>
		<protocols>
			<local_area_network id='730cff440fce49a19b506fb474693eb8'/>
			<wireless_local_area_network id='cb922fc1e8df47e29f36ea6c5954498e'/>
		</protocols>
	</module>
	<module id='3520ea3185724a42acc95bb1d39aa435'>
		<vendor_name></vendor_name>
		<vendor_model></vendor_model>
		<hardware_version></hardware_version>
		<firmware_version></firmware_version>
		<created_date>2019-12-28T14:24:10.945+01:00</created_date>
		<modified_date>2019-12-28T14:24:11.563+01:00</modified_date>
		<deleted_date></deleted_date>
		<services>
			<gas_interval_meter id='695803fc9dd845ccb008148d266c1c2f' log_type='gas'>
				<functionalities><interval_log id='60ab4470620247d7aab6ece025561ff0'/></functionalities>
			</gas_interval_meter>
			<gas_cumulative_meter id='8f4af03185764157afd27218a84ace74' log_type='gas'>
				<functionalities><cumulative_log id='0c131b9382194e5aba43f8113363d5e2'/></functionalities>
			</gas_cumulative_meter>
		</services>
		<protocols>
			<dsmr_gas id='7235c4b59ef24722bd8c899109308942'>
				<serial>G0059003922418819</serial>
				<dsmr_main id='4192221cab3249a8a5629e61fb405b2f'/>
			</dsmr_gas>
		</protocols>
	</module>
</domain_objects>

domain objects:
<domain_objects>
<module id="b278caf322124cf0bd4b84c0e514a295">
<vendor_name>Xemex</vendor_name>
<vendor_model>XMX5XMXABCE000021673</vendor_model>
<hardware_version/>
<firmware_version/>
<created_date>2013-04-08T09:00:00+02:00</created_date>
<modified_date>2019-01-26T15:40:02.447+01:00</modified_date>
<deleted_date/>
<services>
<electricity_cumulative_meter id="a17aa51dda834556905f3ea1689d18f7">
<measurement log_date="2019-01-26T15:35:00+01:00" unit="Wh" directionality="produced" tariff_indicator="nl_offpeak">1575458.000</measurement>
<measurement log_date="2019-01-26T15:35:00+01:00" unit="Wh" directionality="produced" tariff_indicator="nl_peak">4267304.000</measurement>
<measurement log_date="2019-01-26T15:35:00+01:00" unit="Wh" directionality="consumed" tariff_indicator="nl_offpeak">16796096.000</measurement>
<measurement log_date="2019-01-26T15:35:00+01:00" unit="Wh" directionality="consumed" tariff_indicator="nl_peak">10393436.000</measurement>
</electricity_cumulative_meter>
<electricity_interval_meter id="6765e34867314ccb886bb72455610694">
<measurement log_date="2019-01-26T15:00:00+01:00" unit="Wh" interval="PT300S" directionality="produced" tariff_indicator="nl_offpeak">-0.000</measurement>
<measurement log_date="2019-01-26T15:00:00+01:00" unit="Wh" interval="PT300S" directionality="produced" tariff_indicator="nl_peak">0.000</measurement>
<measurement log_date="2019-01-26T15:00:00+01:00" unit="Wh" interval="PT300S" directionality="consumed" tariff_indicator="nl_offpeak">562.000</measurement>
<measurement log_date="2019-01-26T15:00:00+01:00" unit="Wh" interval="PT300S" directionality="consumed" tariff_indicator="nl_peak">0.000</measurement>
</electricity_interval_meter>
<electricity_point_meter id="c35b5cf0b4eb46c2989dba87d07b1b7b">
<measurement log_date="2019-01-26T15:39:56+01:00" unit="W" directionality="produced">0.000</measurement>
<measurement log_date="2019-01-26T15:39:56+01:00" unit="W" directionality="consumed">320.000</measurement>
</electricity_point_meter>
</services>
<protocols>
<dsmrmain id="7ce8353c44db4198bb83d446b68cec01">
<serial>98108309 </serial>
<dsmrmbuses>
<dsmrgas id="f7b2aeab9f1e43e8b4e2d37b73f96045"/>
</dsmrmbuses>
</dsmrmain>
</protocols>
</module>
<module id="b48aaa16b25046baa84feaa084922e8f">
<vendor_name/>
<vendor_model/>
<hardware_version/>
<firmware_version/>
<created_date>2013-04-08T08:00:00+02:00</created_date>
<modified_date>2019-01-26T15:40:02.447+01:00</modified_date>
<deleted_date/>
<services>
<gas_interval_meter id="9a438f7016734f3cb3835e8c3a9b92d5">
<measurement log_date="2019-01-26T14:00:00+01:00" unit="m3" interval="PT1H" directionality="consumed">0.207</measurement>
</gas_interval_meter>
<gas_cumulative_meter id="44e77f7762c84cc8973a752a8128caf5">
<measurement log_date="2019-01-26T15:00:00+01:00" unit="m3" directionality="consumed">6542.004</measurement>
</gas_cumulative_meter>
</services>
<protocols>
<dsmrgas id="f7b2aeab9f1e43e8b4e2d37b73f96045">
<serial>28011001147026511</serial>
<dsmrmain id="7ce8353c44db4198bb83d446b68cec01"/>
</dsmrgas>
</protocols>
</module>
<location id="fafcd13da58c4547816ca7f01b68c97a">
<name>P1 Meter</name>
<description/>
<type>building</type>
<created_date>2012-07-31T15:05:08+02:00</created_date>
<modified_date>2015-03-24T12:55:17+01:00</modified_date>
<deleted_date/>
<actuators/>
<locations/>
<appliances/>
<services>
<electricity_interval_meter id="6765e34867314ccb886bb72455610694"/>
<gas_cumulative_meter id="44e77f7762c84cc8973a752a8128caf5"/>
<gas_interval_meter id="9a438f7016734f3cb3835e8c3a9b92d5"/>
<electricity_point_meter id="c35b5cf0b4eb46c2989dba87d07b1b7b"/>
<electricity_cumulative_meter id="a17aa51dda834556905f3ea1689d18f7"/>
</services>
<logs>
<point_log id="1b9c83a9e28d4f33bfa5fcc5b8435a71">
<unit>W</unit>
<type>electricity_produced</type>
<last_consecutive_log_date>2019-01-26T15:39:56+01:00</last_consecutive_log_date>
<updated_date>2019-01-26T15:39:56+01:00</updated_date>
<period start_date="2015-02-21T12:30:05+01:00" end_date="2019-01-26T15:39:56+01:00">
<measurement log_date="2019-01-26T15:39:56+01:00">0.000</measurement>
</period>
</point_log>
<interval_log id="3418669cbeee4913b5e6ef4564dc28db">
<unit>Wh</unit>
<type>electricity_consumed</type>
<last_consecutive_log_date>2019-01-26T14:00:00+01:00</last_consecutive_log_date>
<updated_date>2019-01-26T15:00:00+01:00</updated_date>
<interval>PT300S</interval>
<period start_date="2015-02-21T13:00:00+01:00" end_date="2019-01-26T15:00:00+01:00" interval="PT1H">
<measurement log_date="2019-01-26T15:00:00+01:00" tariff_indicator="nl_offpeak">562.000</measurement>
<measurement log_date="2019-01-26T15:00:00+01:00" tariff_indicator="nl_peak">0.000</measurement>
</period>
</interval_log>
<point_log id="1ef46525fa584c38b02b9a52227f2907">
<unit>W</unit>
<type>electricity_consumed</type>
<last_consecutive_log_date>2019-01-26T15:39:56+01:00</last_consecutive_log_date>
<updated_date>2019-01-26T15:39:56+01:00</updated_date>
<period start_date="2015-02-21T12:30:05+01:00" end_date="2019-01-26T15:39:56+01:00">
<measurement log_date="2019-01-26T15:39:56+01:00">320.000</measurement>
</period>
</point_log>
<cumulative_log id="497cc22ea315486fade7fae0b2ab730e">
<unit>Wh</unit>
<type>electricity_consumed</type>
<last_consecutive_log_date>2019-01-26T15:35:00+01:00</last_consecutive_log_date>
<updated_date>2019-01-26T15:35:00+01:00</updated_date>
<period start_date="2015-02-21T12:30:05+01:00" end_date="2019-01-26T15:35:00+01:00">
<measurement log_date="2019-01-26T15:35:00+01:00" tariff_indicator="nl_offpeak">16796096.000</measurement>
<measurement log_date="2019-01-26T15:35:00+01:00" tariff_indicator="nl_peak">10393436.000</measurement>
</period>
</cumulative_log>
<cumulative_log id="9ce1baaf6a7a4d5fb01ac07524b37315">
<unit>Wh</unit>
<type>electricity_produced</type>
<last_consecutive_log_date>2019-01-26T15:35:00+01:00</last_consecutive_log_date>
<updated_date>2019-01-26T15:35:00+01:00</updated_date>
<period start_date="2015-02-21T12:30:05+01:00" end_date="2019-01-26T15:35:00+01:00">
<measurement log_date="2019-01-26T15:35:00+01:00" tariff_indicator="nl_offpeak">1575458.000</measurement>
<measurement log_date="2019-01-26T15:35:00+01:00" tariff_indicator="nl_peak">4267304.000</measurement>
</period>
</cumulative_log>
<cumulative_log id="565ac17fc65048479dfc17a34db294c1">
<unit>m3</unit>
<type>gas_consumed</type>
<last_consecutive_log_date>2019-01-26T15:00:00+01:00</last_consecutive_log_date>
<updated_date>2019-01-26T15:00:00+01:00</updated_date>
<period start_date="2015-02-21T13:00:00+01:00" end_date="2019-01-26T15:00:00+01:00">
<measurement log_date="2019-01-26T15:00:00+01:00">6542.004</measurement>
</period>
</cumulative_log>
<interval_log id="46874d195710417eadf4d033587690d6">
<unit>m3</unit>
<type>gas_consumed</type>
<last_consecutive_log_date>2019-01-26T14:00:00+01:00</last_consecutive_log_date>
<updated_date>2019-01-26T14:00:00+01:00</updated_date>
<interval>PT1H</interval>
<period start_date="2015-02-21T13:00:00+01:00" end_date="2019-01-26T14:00:00+01:00" interval="PT1H">
<measurement log_date="2019-01-26T14:00:00+01:00">0.207</measurement>
</period>
</interval_log>
<interval_log id="b0405bfdc023490592642a7882bae5b6">
<unit>Wh</unit>
<type>electricity_produced</type>
<last_consecutive_log_date>2019-01-26T14:00:00+01:00</last_consecutive_log_date>
<updated_date>2019-01-26T15:00:00+01:00</updated_date>
<interval>PT300S</interval>
<period start_date="2015-02-21T13:00:00+01:00" end_date="2019-01-26T15:00:00+01:00" interval="PT1H">
<measurement log_date="2019-01-26T15:00:00+01:00" tariff_indicator="nl_offpeak">-0.000</measurement>
<measurement log_date="2019-01-26T15:00:00+01:00" tariff_indicator="nl_peak">0.000</measurement>
</period>
</interval_log>
</logs>
</location>
</domain_objects>

domain_objects JSON:
{ domain_objects:
   { module:
      [ { vendor_name: { _text: 'Xemex' },
          vendor_model: { _text: 'XMX5XMXABCE000021673' },
          hardware_version: {},
          firmware_version: {},
          created_date: { _text: '2013-04-08T09:00:00+02:00' },
          modified_date: { _text: '2019-02-03T12:03:22.477+01:00' },
          deleted_date: {},
          services:
           { electricity_interval_meter:
              { measurement:
                 [ { _text: '99.307' },
                   { _text: '14.917' },
                   { _text: '403.204' },
                   { _text: '221.708' } ] },
             electricity_point_meter: { measurement: [ { _text: '0.000' }, { _text: '0.000' } ] },
             electricity_cumulative_meter:
              { measurement:
                 [ { _text: '1576060.000' },
                   { _text: '4270570.000' },
                   { _text: '16886728.000' },
                   { _text: '10441977.000' } ] } },
          protocols:
           { dsmrmain:
              { serial: { _text: '98108309        ' },
                dsmrmbuses: { dsmrgas: {} } } } },
        { vendor_name: {},
          vendor_model: {},
          hardware_version: {},
          firmware_version: {},
          created_date: { _text: '2013-04-08T08:00:00+02:00' },
          modified_date: { _text: '2019-02-03T12:03:22.477+01:00' },
          deleted_date: {},
          services:
           { gas_interval_meter: { measurement: { _text: '0.275' } },
             gas_cumulative_meter: { measurement: { _text: '6593.415' } } },
          protocols:
           { dsmrgas: { serial: { _text: '28011001147026511' }, dsmrmain: {} } } } ],
     location:
      { name: { _text: 'P1 Meter' },
        description: {},
        type: { _text: 'building' },
        created_date: { _text: '2012-07-31T15:05:08+02:00' },
        modified_date: { _text: '2015-03-24T12:55:17+01:00' },
        deleted_date: {},
        actuators: {},
        locations: {},
        appliances: {},
        services:
         { electricity_cumulative_meter: {},
           gas_interval_meter: {},
           electricity_interval_meter: {},
           gas_cumulative_meter: {},
           electricity_point_meter: {} },
        logs:
         { cumulative_log:
            [ { unit: { _text: 'Wh' },
                type: { _text: 'electricity_produced' },
                last_consecutive_log_date: { _text: '2019-02-03T12:00:00+01:00' },
                updated_date: { _text: '2019-02-03T12:00:00+01:00' },
                period:
                 { measurement: [ { _text: '1576060.000' }, { _text: '4270570.000' } ] } },
              { unit: { _text: 'm3' },
                type: { _text: 'gas_consumed' },
                last_consecutive_log_date: { _text: '2019-02-03T11:00:00+01:00' },
                updated_date: { _text: '2019-02-03T11:00:00+01:00' },
                period: { measurement: { _text: '6593.415' } } },
              { unit: { _text: 'Wh' },
                type: { _text: 'electricity_consumed' },
                last_consecutive_log_date: { _text: '2019-02-03T12:00:00+01:00' },
                updated_date: { _text: '2019-02-03T12:00:00+01:00' },
                period:
                 { measurement: [ { _text: '16886728.000' }, { _text: '10441977.000' } ] } } ],
           interval_log:
            [ { unit: { _text: 'Wh' },
                type: { _text: 'electricity_consumed' },
                last_consecutive_log_date: { _text: '2019-02-03T11:00:00+01:00' },
                updated_date: { _text: '2019-02-03T11:00:00+01:00' },
                interval: { _text: 'PT300S' },
                period:
                 { measurement: [ { _text: '403.204' }, { _text: '221.708' } ] } },
              { unit: { _text: 'm3' },
                type: { _text: 'gas_consumed' },
                last_consecutive_log_date: { _text: '2019-02-03T10:00:00+01:00' },
                updated_date: { _text: '2019-02-03T10:00:00+01:00' },
                interval: { _text: 'PT1H' },
                period: { measurement: { _text: '0.275' } } },
              { unit: { _text: 'Wh' },
                type: { _text: 'electricity_produced' },
                last_consecutive_log_date: { _text: '2019-02-03T11:00:00+01:00' },
                updated_date: { _text: '2019-02-03T11:00:00+01:00' },
                interval: { _text: 'PT300S' },
                period:
                 { measurement: [ { _text: '99.307' }, { _text: '14.917' } ] } } ],
           point_log:
            [ { unit: { _text: 'W' },
                type: { _text: 'electricity_produced' },
                last_consecutive_log_date: { _text: '2019-02-03T12:03:18+01:00' },
                updated_date: { _text: '2019-02-03T12:03:18+01:00' },
                period: { measurement: { _text: '0.000' } } },
              { unit: { _text: 'W' },
                type: { _text: 'electricity_consumed' },
                last_consecutive_log_date: { _text: '2019-02-03T12:03:18+01:00' },
                updated_date: { _text: '2019-02-03T12:03:18+01:00' },
                period: { measurement: { _text: '0.000' } } } ] } } } }

*/
