## Node package to interface directly with Plugwise Smile P1 energy monitor devices (no Stretch or bridge required).

### It allows you to:

#### get:
* firmware version
* live energy and gas readings of P1 smart meters

#### set:
* nothing (yet)

#### do:
* discover the device in a local network (Not implemented yet :) )
* login with device ID

### Note:
This package has been developed and tested with firmware version 2 and 3.

### Install:
If you don't have Node installed yet, get it from: [Nodejs.org](https://nodejs.org "Nodejs website").

To install the Smile P1 package:
```
> npm i smilep1
```

### Test:
From the folder in which you installed the SmileP1 package, just run below command. The port only needs to be set if you are not using the default port 80.
```
> npm test id=yourDeviceID host=yourDeviceIP port=yourHostPort
```

### Quickstart:

```
// create a Smile P1 session, login to device, fetch meter readings
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
```

## Detailed documentation:
[Detailed documentation](https://gruijter.github.io/smilep1.js/ "smilep1.js documentation")

