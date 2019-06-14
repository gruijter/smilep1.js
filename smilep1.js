/* eslint-disable prefer-destructuring */
/* This Source Code Form is subject to the terms of the Mozilla Public
	License, v. 2.0. If a copy of the MPL was not distributed with this
	file, You can obtain one at http://mozilla.org/MPL/2.0/.

	Copyright 2016 - 2019, Robin de Gruijter <gruijter@hotmail.com> */

'use strict';

const parseXml = require('xml-js');
const http = require('http');
const https = require('https');
// const util = require('util');

// v2 and v3 firmware
const modulesPath = '/core/modules';
const objectsPath = '/core/direct_objects';
const domainObjectsPath = '/core/domain_objects';
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
const servicesPath = '/core/modules;class=Services';

const defaultPort = 80;
const defaultTimeout = 4000;

const regexMeasurePower = new RegExp(/unit='W' directionality='consumed'>(.*?)<\/measurement>/);
const regexMeasurePowerProduced = new RegExp(/unit='W' directionality='produced'>(.*?)<\/measurement>/);
const regexPowerPeak = new RegExp(/unit='Wh' directionality='consumed' tariff_indicator='nl_peak'>(.*?)<\/measurement>/);
const regexPowerOffpeak = new RegExp(/unit='Wh' directionality='consumed' tariff_indicator='nl_offpeak'>(.*?)<\/measurement>/);
const regexPowerPeakProduced = new RegExp(/unit='Wh' directionality='produced' tariff_indicator='nl_peak'>(.*?)<\/measurement>/);
const regexPowerOffpeakProduced = new RegExp(/unit='Wh' directionality='produced' tariff_indicator='nl_offpeak'>(.*?)<\/measurement>/);
const regexGas = new RegExp(/unit='m3' directionality='consumed'>(.*?)<\/measurement>/);
const regexPowerTm = new RegExp(/<measurement log_date='(.*?)' unit='Wh' directionality='consumed' tariff_indicator='nl_offpeak'>/);
const regexGasTm = new RegExp(/<measurement log_date='(.*?)' unit='m3' directionality='consumed'>/);
const regexFwLevel2 = new RegExp(/<version>(.*?)<\/version>/);
const regexFwLevel3 = new RegExp(/<firmware_version>(.*?)<\/firmware_version>/);

class SmileP1 {
	// Represents a session to a Plugwise Smile P1 device.
	constructor(opts) {	// id, host, port, timeout, meterMethod
		const options = opts || {};
		this.id = options.id;
		this.host = options.host;
		this.port = options.port || defaultPort;
		this.timeout = options.timeout || defaultTimeout;
		this.loggedIn = true;
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
			await this.getFirmwareLevel();
			this.loggedIn = true;
			return Promise.resolve(this.loggedIn);
		} catch (error) {
			this.loggedIn = false;
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
	* Get the meterMethod. Returns 1 for firmware below 3, returns 2 otherwise
	* @returns {Promise.<meterMethod>} The meter Method.
	*/
	async getMeterMethod() {
		try {
			this.getFirmwareLevel();
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

	/**
	* Get status information of the Smile P1 device. (V2 firmware only)
	* @returns {Promise.<status>} The status information.
	*/
	async getStatus() {
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

	/**
	* Get the power  and gas meter readings.
	* @returns {Promise<meterReadings>}
	*/
	async getMeterReadings() {
		try {
			if (!this.meterMethod) {
				await this.getMeterMethod();
			}
			let readings = {};
			// method 1 for fw 2
			if (this.meterMethod === 1) {
				readings = await this._getMeterReadings1()
					.catch(() => undefined);
			} else {	// method 2 as default
				readings = await this._getMeterReadings2();
			}
			return Promise.resolve(readings);
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
				const powerTm = Date.parse(regexPowerTm.exec(result)[1]);
				readings.pwr = measurePower - measurePowerProduced;
				readings.net = powerPeak + powerOffpeak - powerPeakProduced - powerOffpeakProduced;
				readings.p2 = powerPeak;
				readings.p1 = powerOffpeak;
				readings.n2 = powerPeakProduced;
				readings.n1 = powerOffpeakProduced;
				readings.tm = powerTm;
			}	catch (err) {
				// console.log('Error parsing power information, or no power readings available');
			}
			try {
				const gas = Number(regexGas.exec(result)[1]);
				const gasTm = Date.parse(regexGasTm.exec(result)[1]);
				readings.gas = gas;
				readings.gtm = gasTm;
			}	catch (err) {
				// console.log('Error parsing gas information, or no gas readings available');
			}
			if (!readings.tm && !readings.gtm) {
				throw Error('Error parsing meter info');
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
			const result = await this._makeRequest(objectsPath);
			// parse xml to json object
			const parseOptions = {
				compact: true, nativeType: true, ignoreDeclaration: true, // spaces: 2,
			};
			const json = parseXml.xml2js(result, parseOptions);
			const logs = json.direct_objects.location.logs;
			// console.log(logs);
			try {
				logs.cumulative_log.forEach((log) => {
					if (log.type._text === 'electricity_consumed') {
						powerOffpeak = log.period.measurement.filter(m => (m._attributes.tariff_indicator === 'nl_offpeak'
							|| m._attributes.tariff === 'nl_offpeak'))[0]._text / 1000;
						powerPeak = log.period.measurement.filter(m => (m._attributes.tariff_indicator === 'nl_peak'
						|| m._attributes.tariff === 'nl_peak'))[0]._text / 1000;
						powerTm = log.updated_date._text;	// e.g. '2019-02-03T12:00:00+01:00'
					}
					if (log.type._text === 'electricity_produced') {
						powerOffpeakProduced = log.period.measurement.filter(m => (m._attributes.tariff_indicator === 'nl_offpeak'
						|| m._attributes.tariff === 'nl_offpeak'))[0]._text / 1000;
						powerPeakProduced = log.period.measurement.filter(m => (m._attributes.tariff_indicator === 'nl_peak'
						|| m._attributes.tariff === 'nl_peak'))[0]._text / 1000;
					}
					if (log.type._text === 'gas_consumed') {
						gas = log.period.measurement._text;	// gas
						gasTm = log.updated_date._text;	// e.g. '2019-02-03T12:00:00+01:00'
					}
				});
				logs.point_log.forEach((log) => {
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
			} catch (err) {
				console.log(JSON.stringify(logs));
				throw err;
			}
			readings.pwr = measurePower - measurePowerProduced;
			readings.net = powerPeak + powerOffpeak - powerPeakProduced - powerOffpeakProduced;
			readings.p2 = powerPeak;
			readings.p1 = powerOffpeak;
			readings.n2 = powerPeakProduced;
			readings.n1 = powerOffpeakProduced;
			readings.tm = Date.parse(new Date(powerTm));
			readings.gas = gas;
			readings.gtm = Date.parse(new Date(gasTm));
			return Promise.resolve(readings);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async _makeRequest(actionPath, force) {
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
				result = await this._makeHttpsRequest(options, postMessage);
			} else {
				result = await this._makeHttpRequest(options, postMessage);
			}
			this.lastResponse = result.body;
			if (result.headers['set-cookie']) {
				this.cookie = result.headers['set-cookie'];
			}
			if (result.statusCode === 401) {
				this.lastResponse = result.statusCode;
				throw Error('401 Unauthorized (wrong smileId or wrong IP)');
			}
			if (result.statusCode !== 200) {
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
			const req = http.request(options, (res) => {
				let resBody = '';
				res.on('data', (chunk) => {
					resBody += chunk;
				});
				res.once('end', () => {
					res.body = resBody;
					return resolve(res); // resolve the request
				});
			});
			req.setTimeout(timeout || this.timeout, () => {
				req.abort();
			});
			req.once('error', (e) => {
				this.lastResponse = e;	// e.g. ECONNREFUSED on wrong port or wrong IP // ECONNRESET on wrong IP
				return reject(e);
			});
			// req.write(postData);
			req.end(postData);
		});
	}

	_makeHttpsRequest(options, postData, timeout) {
		return new Promise((resolve, reject) => {
			const req = https.request(options, (res) => {
				let resBody = '';
				res.on('data', (chunk) => {
					resBody += chunk;
				});
				res.once('end', () => {
					res.body = resBody;
					return resolve(res); // resolve the request
				});
			});
			req.setTimeout(timeout || this.timeout, () => {
				req.abort();
			});
			req.once('error', (e) => {
				this.lastResponse = e;	// e.g. ECONNREFUSED on wrong port or wrong IP // ECONNRESET on wrong IP
				return reject(e);
			});
			// req.write(postData);
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
* @property {number} [timeout = 4000] - http(s) timeout in milliseconds. Defaults to 4000ms.
* @property {number} [meterMethod] - 1 for fw2, 2 for fw 3. Will be automaically determined if undefined.
* @example // session options
{ id: 'hcfrasde',
  host:'192.168.1.50',
  port: 443,
  timeout: 5000 }
*/

/**
* @typedef meterReadings
* @description meterReadings is an object containing power and gas information.
* @property {number} pwr power meter total (consumption - production) in kWh. e.g. 7507.336
* @property {number} net power consumption in Watt. e.g. 3030
* @property {number} p2 P2 consumption counter (high tariff). e.g. 896.812
* @property {number} p1 P1 consumption counter (low tariff). e.g. 16110.964
* @property {number} n2 N2 production counter (high tariff). e.g. 4250.32
* @property {number} n1 N1 production counter (low tariff). e.g. 1570.936
* @property {number} tm time of retrieving info. unix-time-format. e.g. 1542575626
* @property {number} gas counter gas-meter (in m^3). e.g. 6161.243
* @property {number} gtm time of the last gas measurement. unix-time-format. e.g. 1542574800
* @example // meterReadings
{	pwr: 646,
	net: 7507.335999999999,
	p2: 5540.311,
	p1: 3161.826,
	n2: 400.407,
	n1: 794.394,
	tm: 1560178800000,
	gas: 2162.69,
	gtm: 1560178800000 }
*/

/**
* @typedef status
* @description status is an object containing Smile P1 device information. Note: Only works for V2 firmware!
* @property {object} status Object containing system information
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
  g: { gas: 4977.361, gasTm: 1490623200000 }
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
