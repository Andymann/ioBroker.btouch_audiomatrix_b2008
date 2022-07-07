"use strict";

/*
 * Created with @iobroker/create-adapter v1.25.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");

// Load your modules here, e.g.:
// const fs = require('fs');
const net = require('net');


//const ByteLength = require('@serialport/parser-byte-length');
//const port = new SerialPort('/dev/ttyUSB0', {baudrate: 115200});
//const parser = port.pipe(new ByteLength({length: 1}));

//----VOR 2022
//const serialport = require('serialport');
//const ByteLength = require('@serialport/parser-byte-length');

//----Nach 2021
const { SerialPort } = require('serialport');
const { ByteLengthParser } = require('serialport');

let matrix = null;

let parentThis;

let arrCMD = [];
let bConnection = false;
let bWaitingForResponse = false;
let cmdInterval;
let pingInterval;
let iMissedPingCounter = 0;
let query;
let bWaitQueue = false;
let bFirstPing = true;
let bHasIncomingData = false;
let in_msg = '';
let serPort = '';

//----TEST
let bSerialCommunication = true;

const TIMEOUT = 5000;
const cmdConnect = new Buffer([0x5a, 0xa5, 0x14, 0x00, 0x40, 0x00, 0x00, 0x00, 0x0a, 0x5d]);
const cmdDisconnect = new Buffer([0x5a, 0xa5, 0x14, 0x01, 0x3f, 0x80, 0x00, 0x00, 0x0a, 0x5d]);
const cmdBasicResponse = new Buffer([0x5a, 0xa5, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0x0a, 0xa9]);
const cmdTransmissionDone = new Buffer([0x5a, 0xa5, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0x0a, 0xaf]);
//const cmdPreset_Init0 = new Buffer([0x5a, 0xa5, 0x10, 0x11, 0x00, 0x00, 0x00, 0x00, 0x0a, 0xaf]);	/* Preset to load after PowerOn */
//const cmdPreset_Save0 = new Buffer([0x5a, 0xa5, 0x10, 0x10, 0x00, 0x00, 0x00, 0x00, 0x0a, 0xaf]);	/* Preset to save settings to */

const cmdVol000 = new Buffer([0x5a, 0xa5, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x10]);
const cmdWaitQueue_1000 = new Buffer([0x03, 0xe8]);

let arrRouting = [false, false, false, false, false, false, false, false,
	false, false, false, false, false, false, false, false,
	false, false, false, false, false, false, false, false,
	false, false, false, false, false, false, false, false,
	false, false, false, false, false, false, false, false,
	false, false, false, false, false, false, false, false,
	false, false, false, false, false, false, false, false,
	false, false, false, false, false, false, false, false];



//----https://gist.github.com/Jozo132/2c0fae763f5dc6635a6714bb741d152f
const Float32ToHex = float32 => {
	const getHex = i => ('00' + i.toString(16)).slice(-2);
	const view = new DataView(new ArrayBuffer(4));
	view.setFloat32(0, float32);
	return Array.apply(null, { length: 4 })
		.map((_, i) => getHex(view.getUint8(i)))
		.join('');
};

const Float32ToBin = float32 =>
	parseInt(Float32ToHex(float32), 16)
		.toString(2)
		.padStart(32, '0');
const conv754 = float32 => {
	const getHex = i => parseInt(('00' + i.toString(16)).slice(-2), 16);
	const view = new DataView(new ArrayBuffer(4));
	view.setFloat32(0, float32);
	return Array.apply(null, { length: 4 }).map((_, i) => getHex(view.getUint8(i)));
};

const ToFloat32 = num => {
	if (num > 0 || num < 0) {
		const sign = num >>> 31 ? -1 : 1;
		let exp = ((num >>> 23) & 0xff) - 127;
		const mantissa = ((num & 0x7fffff) + 0x800000).toString(2);
		let float32 = 0;
		for (let i = 0; i < mantissa.length; i += 1) {
			float32 += parseInt(mantissa[i]) ? Math.pow(2, exp) : 0;
			exp--;
		}
		return float32 * sign;
	} else return 0;
};

const HexToFloat32 = str => ToFloat32(parseInt(str, 16));
const BinToFloat32 = str => ToFloat32(parseInt(str, 2));

//https://gist.github.com/xposedbones/75ebaef3c10060a3ee3b246166caab56
//---- Wert, IN von, IN bis, OUT von, OUT bis
const map = (value, x1, y1, x2, y2) => ((value - x1) * (y2 - x2)) / (y1 - x1) + x2;

function toHexString(byteArray) {
	return Array.from(byteArray, function (byte) {
		return ('0' + (byte & 0xff).toString(16)).slice(-2);
	}).join('');
}

//----Rudimentaere Funktion, um syntaktisch prinzipiell korrekte Werte sichezustellen
function simpleMap(pMinimal, pMaximal, pVal) {
	if (pVal < pMinimal) {
		pVal = pMinimal;
	} else if (pVal > pMaximal) {
		pVal = pMaximal;
	}
	return pVal;
}

//----Gibt den Array mit korrekter Checksumme zurueck
function convertArray(array) {
	const tmpArr = array.slice();

	let tmpChk = 0;
	for (let i = 0; i < array.length - 1; i++) {
		tmpChk += array[i];
	}
	tmpChk = tmpChk & 0xff;
	tmpArr[tmpArr.length - 1] = tmpChk;
	return tmpArr;
}
class BtouchAudiomatrixB2008 extends utils.Adapter {
	/**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
	constructor(options) {
		super({
			...options,
			name: "btouch_audiomatrix_b2008",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("objectChange", this.onObjectChange.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));

		parentThis = this;
	}

	//==================================================================================
	initMatrix() {
		this.log.info('initMatrix().');

		arrCMD = [];
		bWaitingForResponse = false;
		bConnection = false;
		bWaitQueue = false;
		bHasIncomingData = false;
		bFirstPing = true;
		iMissedPingCounter = 0;


		//----CMD-Queue einrichten   
		clearInterval(cmdInterval);
		cmdInterval = setInterval(function () {
			parentThis.processCMD();
		}, 100);

		this.connectMatrix();
	}

	disconnectMatrix() {
		if (bSerialCommunication == true) {
			this.log.info('disConnectMatrix() Serial');
			if (matrix.isOpen) {
				matrix.close();
				matrix.destroy();
			}
		} else {
			this.log.info('disConnectMatrix() Network');
			matrix.destroy();
		}
	}

	connectMatrix(cb) {
		//this.log.info('connectMatrix()');
		let parser;
		arrCMD = [];

		if (bSerialCommunication == true) {
			this.log.info('connectMatrix(): Serial Port Mode');

			//----NEU
			matrix = new SerialPort({
				path: '/dev/ttyUSB0',
				baudRate: 115200,
				dataBits: 8,
				stopBits: 1,
				parity: 'none'
			});
			
			parser = matrix.pipe(new ByteLengthParser({ length: 1 }));
			//---ALT
			//const options = {
				//	baudRate: 115200,
				//	dataBits: 8,
				//	stopBits: 1,
				//	parity: 'none'
				//};
				
			// matrix = new serialport('/dev/ttyUSB0', options);
			//parser = matrix.pipe(new ByteLength({ length: 1 }));
			
			//matrix = new serialport(this.serPort, options);
			//----
			if (bConnection == false) {
				parentThis.log.debug('connectMatrix() Serial. bConnection==false, sending CMDCONNECT:' + toHexString(cmdConnect));
				arrCMD.push(cmdConnect);
				arrCMD.push(cmdWaitQueue_1000);
			} else {
				parentThis.log.debug('_connect() Serial. bConnection==true. Nichts tun');
			}
			if (pingInterval) {
				clearInterval(pingInterval);
			}

			//----Alle 1,5 Sekunden ein PING
			pingInterval = setInterval(function () {
				parentThis.pingMatrix();
			}, 750);

		} else {
			this.log.info('connectMatrix():' + this.config.host + ':' + this.config.port);
			matrix = new net.Socket();

			matrix.connect(this.config.port, this.config.host, function () {
				if (bConnection == false) {
					parentThis.log.debug('connectMatrix() Network. bConnection==false, sending CMDCONNECT:' + toHexString(cmdConnect));
					arrCMD.push(cmdConnect);
					arrCMD.push(cmdWaitQueue_1000);
				} else {
					parentThis.log.debug('_connect() Network. bConnection==true. Nichts tun');
				}
				if (pingInterval) {
					clearInterval(pingInterval);
				}

				//----Alle 0,75 Sekunden ein PING
				pingInterval = setInterval(function () {
					parentThis.pingMatrix();
				}, 750);
			});
		}


		matrix.on('data', function (chunk) {
			if (bSerialCommunication == false) {
				parentThis.processIncoming(chunk);
			}
			//parentThis.log.info('matrix.onData()');
			//parentThis.log.info('matrix.onData(): ' + parentThis.toHexString(chunk) );

		});

		matrix.on('timeout', function (e) {
			//if (e.code == 'ENOTFOUND' || e.code == 'ECONNREFUSED' || e.code == 'ETIMEDOUT') {
			//            matrix.destroy();
			//}
			parentThis.log.error('AudioMatrix TIMEOUT. TBD');
			//parentThis.connection=false;
			//parentThis.setConnState(false, true);
			//            parentThis.reconnect();
		});

		matrix.on('error', function (e) {
			if (e.code == 'ENOTFOUND' || e.code == 'ECONNREFUSED' || e.code == 'ETIMEDOUT') {
				//matrix.destroy();
				//parentThis.initMatrix();
				if (e.code == 'ECONNREFUSED') {
					parentThis.log.error('Keine Verbindung. Ist der Adapter online?');
					arrCMD.push(cmdWaitQueue_1000);

				}
			}
			parentThis.log.error(e);
			//            parentThis.reconnect();
		});

		matrix.on('close', function (e) {
			//if (bConnection) {
			parentThis.log.error('AudioMatrix closed. TBD');
			//}
			//parentThis.reconnect();
		});

		matrix.on('disconnect', function (e) {
			parentThis.log.error('AudioMatrix disconnected. TBD');
			//            parentThis.reconnect();
		});

		matrix.on('end', function (e) {
			parentThis.log.error('AudioMatrix ended');
			//parentThis.setState('info.connection', false, true);
		});


		parser.on('data', function (chunk) {
			//parentThis.log.info('matrix.onData()');
			//parentThis.log.info('matrix.onData(): ' + parentThis.toHexString(chunk) );
			if (bSerialCommunication == true) {
				parentThis.processIncoming(chunk);
			}
			//parentThis.processIncoming(chunk);
		});

	}


	//----ack==FALSE: State was changed via GUI
	changeMatrix(id, val, ack) {
		if (bConnection && val && !val.ack) {
			//this.log.info('matrixChanged: tabu=TRUE' );
			//tabu = true;
		}

		//this.log.info('changeMatrix: ID:' + id.toString());
		//this.log.info('changeMatrix: VAL:' + val.toString());
		//this.log.info('changeMatrix: ACK:' + ack.toString());

		if (ack == false) {
			//----Change via GUI
			//this.log.info('changeMatrix: per GUI. ID:' + id.toString() );
			if (id.toUpperCase().endsWith('MAINVOLUME')) {
				this._changeMainVolume(val);
			} else if (id.toUpperCase().includes('ROUTINGNODE_ID_')) {
				let sTemp = id.substring(id.indexOf('ID_') + 3);
				sTemp = sTemp.substring(0, 2);
				sTemp = sTemp.trim();
				const idVal = parseInt(sTemp);
				const iIn = (idVal - (idVal % 8)) / 8;
				const iOut = idVal - iIn * 8;
				//----Ein- und Ausgang sind jetzt 0-indexed
				this._changeRouting(iIn, iOut, val);
			} else if (id.toUpperCase().includes('ROUTINGNODE_EXCLUSIVE_ID')) {
				let sTemp = id.substring(id.indexOf('ID_') + 3);
				sTemp = sTemp.substring(0, 2);
				sTemp = sTemp.trim();
				const idVal = parseInt(sTemp);
				const iIn = (idVal - (idVal % 8)) / 8;
				const iOut = idVal - iIn * 8;
				//----Ein- und Ausgang sind jetzt 0-indexed
				this._changeExclusiveRouting(iIn, iOut, val);
				this._fixRoutingStates(iIn, iOut, val);

			} else if (id.toUpperCase().includes('INPUTGAIN_')) {
				//----Die ID des InputGains ist einstellig
				let sID = id.substring(id.toUpperCase().indexOf('GAIN_') + 5);
				//sID = sID.substring(0, 1);
				sID = sID.trim();
				let idVal = parseInt(sID);
				idVal -= 1;
				//----0-indexed
				this._changeInputGain(idVal, val);
			} else if (id.toUpperCase().includes('OUTPUTGAIN_')) {
				//----Die ID des OutputGains ist einstellig
				let sID = id.substring(id.toUpperCase().indexOf('GAIN_') + 5);
				//sID = sID.substring(0, 1);
				sID = sID.trim();
				let idVal = parseInt(sID);
				idVal -= 1;
				//----0-indexed
				this._changeOutputGain(idVal, val);
			} else if (id.toUpperCase().includes('MUTE_')) {
				let sID = id.substring(id.toUpperCase().indexOf('MUTE_') + 5);
				sID = sID.trim();
				let idVal = parseInt(sID);
				idVal -= 1;
				//----0-indexed
				this._changeMuting(idVal, val);
			} else if (id.toUpperCase().includes('SAVETOPRESET0')) {
				this.saveToPreset_0();
			}
		} else {
			//----Won't happen. If we are connected to this adapter then it's impossible to change attributes from the
			//----hardware-side (i.e. a button on the front) because the hardware is locked.
		}
	}

	//----0..7
	//----TRUE/ FALSE
	//----Muting OUTPUT
	_changeMuting(pID, pOnOff) {
		const i = pOnOff ? 1 : 0;
		const arrVal = conv754(i);
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x01 /* Ouput number 7--14*/, 0x01 /* Mute */, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x10]);

		tmpCMD[2] = pID + 7;
		tmpCMD[4] = arrVal[0];
		tmpCMD[5] = arrVal[1];
		tmpCMD[6] = arrVal[2];
		tmpCMD[7] = arrVal[3];

		//----fix checksum
		tmpCMD = convertArray(tmpCMD);
		this.log.info('changeMuting(): adding:' + toHexString(tmpCMD));
		arrCMD.push(tmpCMD);
	}

	_changeMainVolume(val) {
		this.log.info('changeMainVolume via GUI: VAL:' + val.toString());
		const arrVal = conv754(val);
		let tmpCMD = cmdVol000.slice();
		tmpCMD[4] = arrVal[0];
		tmpCMD[5] = arrVal[1];
		tmpCMD[6] = arrVal[2];
		tmpCMD[7] = arrVal[3];

		//----fix checksum
		tmpCMD = convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
	}

	//---- pID: 0..7
	//---- pVal: 0..100
	_changeInputGain(pID, pVal) {
		this.log.info('changeInputGain via GUI. ID(Index):' + pID.toString() + ' VAL:' + pVal.toString());
		if (pID >= 0 && pID < 7) {
			pVal = map(pVal, 0, 100, -40, 0);
			this.log.info('changeInputGain via GUI: VAL(neu):' + pVal.toString());
			const arrVal = conv754(pVal);
			let tmpCMD = new Buffer([0x5a, 0xa5, 0x01 /* Input number */, 0x02 /* Gain */, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x10]);

			tmpCMD[2] = pID + 1;
			tmpCMD[4] = arrVal[0];
			tmpCMD[5] = arrVal[1];
			tmpCMD[6] = arrVal[2];
			tmpCMD[7] = arrVal[3];

			//----fix checksum
			tmpCMD = convertArray(tmpCMD);
			this.log.info('changeInputGain(): adding:' + toHexString(tmpCMD));
			arrCMD.push(tmpCMD);
		} else {
			this.log.error('changeInputGain() via GUI: Coax inputs are not supported');
		}
	}


	//---- pID: 0..7
	//---- pVal: 0..100
	_changeOutputGain(pID, pVal) {
		this.log.info('changeOutputGain via GUI. ID(Index):' + pID.toString() + ' VAL:' + pVal.toString());

		//----Displaying the output gain in full numbers
		this.setStateAsync('outputGainDisplay_' + (pID + 1).toString(), { val: Math.round(pVal), ack: true });

		pVal = map(pVal, 0, 100, -40, 0);
		this.log.info('changeOutputGain via GUI: VAL(neu):' + pVal.toString());
		const arrVal = conv754(pVal);
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x01 /* Input number */, 0x02 /* Gain */, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x10]);

		tmpCMD[2] = pID + 7;
		tmpCMD[4] = arrVal[0];
		tmpCMD[5] = arrVal[1];
		tmpCMD[6] = arrVal[2];
		tmpCMD[7] = arrVal[3];

		//----fix checksum
		tmpCMD = convertArray(tmpCMD);
		this.log.info('changeOutputGain(): adding:' + toHexString(tmpCMD));
		arrCMD.push(tmpCMD);


	}

	//----IN: 0-7
	//----OUT:0-8
	//----pOnOff: TRUE / FALSE
	_changeRouting(pIn, pOut, pOnOff) {
		this.log.info('changeRouting() via GUI: In(Index):' + pIn.toString() + ' Out(Index):' + pOut.toString() + ' pOnOff:' + pOnOff.toString());
		if (pIn >= 0 && pIn < 7) {
			let tmpCMD = new Buffer([0x5a, 0xa5, 0x01, 0x33, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x10]);
			const i = pOnOff ? 1 : 0;
			const onOff = conv754(i);

			tmpCMD[2] = pIn + 1;
			tmpCMD[3] = pOut + 50 + 1;
			tmpCMD[4] = onOff[0];
			tmpCMD[5] = onOff[1];
			tmpCMD[6] = onOff[2];
			tmpCMD[7] = onOff[3];

			//----fix checksum
			tmpCMD = convertArray(tmpCMD);
			this.log.info('changeRouting(): adding:' + toHexString(tmpCMD));
			arrCMD.push(tmpCMD);
		} else {
			this.log.error('changeRouting() via GUI: Coax inputs are not supported');
		}
		//this.log.info('changeRouting(): last CMD in arrCMD:' + this.toHexString( arrCMD[arrCMD.length-1] ) );
	}

	//----IN: 0-7
	//----OUT:0-8
	//----pOnOff: TRUE / FALSE
	//----Exclusive Routing can only be switched ON via GUI. Everythin else is handled via the adapter's internal logic
	_changeExclusiveRouting(pIn, pOut, pOnOff) {
		this.log.info('changeExclusiveRouting() via GUI: In(Index):' + pIn.toString() + ' Out(Index):' + pOut.toString() + ' pOnOff:' + pOnOff.toString());

		if (pIn >= 0 && pIn < 7) {
			for (let i = 0; i < 8; i++) {
				if (i !== pIn) {
					//----Switch OFF all other inputs
					this._changeRouting(i, pOut, false);

					let sID = pIn * 8 + i + '';
					while (sID.length < 2) sID = '0' + sID;
					//this.setStateAsync('routingNode_ID_' + sID + '__IN_' + (pIn + 1).toString() + '_OUT_' + (pOut + 1).toString(), { val: false, ack: true });
				}
			}
			//----Exclusive routing can only be switched ON via Gui.
			this._changeRouting(pIn, pOut, true);

			//let sID = pIn * 8 + pOut + '';
			//while (sID.length < 2) sID = '0' + sID;
			//this.setStateAsync('routingNode_ID_' + sID + '__IN_' + (pIn + 1).toString() + '_OUT_' + (pOut + 1).toString(), { val: true, ack: true });
		} else {
			this.log.error('changeExclusiveRouting() via GUI: Coax inputs are not supported yet');
		}


		//this.log.info('changeRouting(): last CMD in arrCMD:' + this.toHexString( arrCMD[arrCMD.length-1] ) );
	}

	//----Fixes ioBroker's internal states according to the routing-situation
	//----Seperated from _changeExlcusiveRouting() since I don't want to write to the hardware from an async function
	//----just because I'm not sure what that might lead to.
	async _fixRoutingStates(pIn, pOut, pOnOff) {
		//this.log.info('changeExclusiveRouting() via GUI: In(Index):' + pIn.toString() + ' Out(Index):' + pOut.toString() + ' pOnOff:' + pOnOff.toString());
		if (pIn >= 0 && pIn < 7) {
			for (let i = 0; i < 8; i++) {
				if (i !== pIn) {
					let sID = i * 8 + pOut + '';
					while (sID.length < 2) sID = '0' + sID;
					//----Die anderen Routingstates muessen entsprechend gesetzt werden. Erstmal alle anderen AUS
					await this.setStateAsync('routingNode_ID_' + sID + '__IN_' + (i + 1).toString() + '_OUT_' + (pOut + 1).toString(), { val: false, ack: true });
					await this.setStateAsync('routingNode_Exclusive_ID_' + sID + '__IN_' + (i + 1).toString() + '_OUT_' + (pOut + 1).toString(), { val: false, ack: true });
				}
			}

			//----and finally the state we want to set
			let sID = (pIn * 8 + pOut).toString();
			while (sID.length < 2) sID = '0' + sID;
			await this.setStateAsync('routingNode_ID_' + sID + '__IN_' + (pIn + 1).toString() + '_OUT_' + (pOut + 1).toString(), { val: true, ack: true });
			await this.setStateAsync('routingNode_Exclusive_ID_' + sID + '__IN_' + (pIn + 1).toString() + '_OUT_' + (pOut + 1).toString(), { val: true, ack: true });

		} else {
			this.log.error('_fixRoutingStates() via GUI: Coax inputs are not supported yet');
		}
	}



	//----Call fron onReady. Creating everything that can later be changed via GUI
	async createStates() {
		this._createState_mainVolume();
		this._createState_Routing();
		this._createState_inputGain();
		this._createState_outputGain();
		this._createState_ExclusiveRouting();
		this._createState_Muting();
		this._createState_outputGain_Display();
		this._createState_Labels();
		this._createState_Save();
	}

	//----Shich Preset to load at Startup
	setInitialPreset() {
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x11 /*initial mode*/, 0x00, 0x00, 0x00, 0x00, 0x0a, 0xaf]); /* Preset 0 */

		//----fix checksum
		tmpCMD = convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
	}

	//----Save active settings to preset #0
	saveToPreset_0() {
		this.log.info('saveToPreset_0');
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x10 /*safe mode*/, 0x00, 0x00, 0x00, 0x00, 0x0a, 0xaf]);

		//----fix checksum
		tmpCMD = convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
		arrCMD.push(cmdWaitQueue_1000);
	}

	//----Sendet die Befehle zum Setzen des korrekten Datums an die Matrix
	setDate() {
		const sDate = (new Date().getDate()).toString() + '.' + (new Date().getMonth() + 1).toString() + '.' + new Date().getFullYear().toString() + ' ' + new Date().getHours().toString() + ':' + new Date().getMinutes().toString();
		this.log.info('setDate(' + sDate + ')');
		this._setHardwareDate_year();
		this._setHardwareDate_month();
		this._setHardwareDate_day();
		this._setHardwareDate_hour();
		this._setHardwareDate_minute();
	}

	_setHardwareDate_year() {
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d]);

		const yyyy = new Date().getFullYear();
		const year = conv754(yyyy);
		tmpCMD[3] = 0x12;
		tmpCMD[4] = year[0];
		tmpCMD[5] = year[1];
		tmpCMD[6] = year[2];
		tmpCMD[7] = year[3];

		//----fix checksum
		tmpCMD = convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
		//parentThis.processCMD();
	}

	_setHardwareDate_month() {
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d]);

		const mm = new Date().getMonth() + 1;
		const month = conv754(mm);
		tmpCMD[3] = 0x13;
		tmpCMD[4] = month[0];
		tmpCMD[5] = month[1];
		tmpCMD[6] = month[2];
		tmpCMD[7] = month[3];

		//----fix checksum
		tmpCMD = convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
	}

	_setHardwareDate_day() {
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d]);

		const dd = new Date().getDate();
		const day = conv754(dd);
		tmpCMD[3] = 0x14;
		tmpCMD[4] = day[0];
		tmpCMD[5] = day[1];
		tmpCMD[6] = day[2];
		tmpCMD[7] = day[3];

		//----fix checksum
		tmpCMD = convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
		//parentThis.processCMD();
	}

	_setHardwareDate_hour() {
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d]);

		const hh = new Date().getHours();
		const hour = conv754(hh);
		tmpCMD[3] = 0x15;
		tmpCMD[4] = hour[0];
		tmpCMD[5] = hour[1];
		tmpCMD[6] = hour[2];
		tmpCMD[7] = hour[3];

		//----fix checksum
		tmpCMD = convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
	}

	_setHardwareDate_minute() {
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d]);

		const mm = new Date().getMinutes();
		const minute = conv754(mm);
		tmpCMD[3] = 0x16;
		tmpCMD[4] = minute[0];
		tmpCMD[5] = minute[1];
		tmpCMD[6] = minute[2];
		tmpCMD[7] = minute[3];

		//----fix checksum
		tmpCMD = convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
	}

	async _createState_mainVolume() {
		parentThis.log.info('createStates(): mainVolume');
		await this.setObjectAsync('mainVolume', {
			type: 'state',
			common: {
				name: 'Main Volume',
				type: 'number',
				role: 'level.volume',
				read: true,
				write: true,
				desc: 'Main Volume',
				min: 0,
				max: 100
			},
			native: {}
		});
	}

	async _createState_inputGain() {
		parentThis.log.info('createStates(): inputGain');
		for (let inVal = 0; inVal < 8; inVal++) {
			await this.setObjectAsync('inputGain_' + (inVal + 1).toString(), {
				type: 'state',
				common: {
					name: 'Input Gain ' + (inVal + 1).toString(),
					type: 'number',
					role: 'level.volume',
					read: true,
					write: true,
					desc: 'Input Gain ' + (inVal + 1).toString(),
					min: 0,
					max: 100
				},
				native: {}
			});
		}
	}

	async _createState_outputGain() {
		parentThis.log.info('createStates(): outputGain');
		for (let outVal = 0; outVal < 8; outVal++) {
			await this.setObjectAsync('outputGain_' + (outVal + 1).toString(), {
				type: 'state',
				common: {
					name: 'Output Gain ' + (outVal + 1).toString(),
					type: 'number',
					role: 'level.volume',
					read: true,
					write: true,
					desc: 'Output Gain' + (outVal + 1).toString(),
					min: 0,
					max: 100
				},
				native: {}
			});
		}
	}

	//----Displays the output gain in whole numbers
	async _createState_outputGain_Display() {
		parentThis.log.info('createStates(): outputGain_Display');
		for (let outVal = 0; outVal < 8; outVal++) {
			await this.setObjectAsync('outputGainDisplay_' + (outVal + 1).toString(), {
				type: 'state',
				common: {
					name: 'Output Gain display in whole numbers ' + (outVal + 1).toString(),
					type: 'number',
					role: 'level.volume',
					read: true,
					write: false,
					desc: 'Output Gain Display in whole numbers' + (outVal + 1).toString(),
					min: 0,
					max: 100
				},
				native: {}
			});
		}
	}

	async _createState_Routing() {
		parentThis.log.info('createStates(): Routing');
		for (let inVal = 0; inVal < 8; inVal++) {
			for (let outVal = 0; outVal < 8; outVal++) {
				//await this.setObjectAsync('routingNode_' + ((in*8 + out)+1).toString(), {
				let sID = inVal * 8 + outVal + '';
				while (sID.length < 2) sID = '0' + sID;

				await this.setObjectAsync('routingNode_ID_' + sID + '__IN_' + (inVal + 1).toString() + '_OUT_' + (outVal + 1).toString(), {
					type: 'state',
					common: {
						name: 'Routing ' + (inVal + 1).toString() + ' -> ' + (outVal + 1).toString(),
						type: 'boolean',
						role: 'indicator',
						desc: 'Routing ' + (inVal + 1).toString() + ' -> ' + (outVal + 1).toString(),
						read: true,
						write: true
					},
					native: {}
				});
			}
		}
	}

	async _createState_ExclusiveRouting() {
		parentThis.log.info('createStates(): ExclusiveRouting');
		for (let inVal = 0; inVal < 8; inVal++) {
			for (let outVal = 0; outVal < 8; outVal++) {
				//await this.setObjectAsync('routingNode_' + ((in*8 + out)+1).toString(), {
				let sID = inVal * 8 + outVal + '';
				while (sID.length < 2) sID = '0' + sID;

				await this.setObjectAsync('routingNode_Exclusive_ID_' + sID + '__IN_' + (inVal + 1).toString() + '_OUT_' + (outVal + 1).toString(), {
					type: 'state',
					common: {
						name: 'Exclusive Routing ' + (inVal + 1).toString() + ' -> ' + (outVal + 1).toString() + '. Deactivates every other input for this output.',
						type: 'boolean',
						role: 'indicator',
						desc: 'Exclusive Routing ' + (inVal + 1).toString() + ' -> ' + (outVal + 1).toString() + '. Deactivates every other input for this output.',
						read: true,
						write: true
					},
					native: {}
				});
			}
		}
	}

	async _createState_Muting() {
		parentThis.log.info('createStates(): Muting');
		for (let i = 0; i < 8; i++) {
			await this.setObjectAsync('mute_' + (i + 1).toString(), {
				type: 'state',
				common: {
					name: 'Mute output #' + (i + 1).toString(),
					type: 'boolean',
					role: 'indicator',
					desc: 'Mute output #' + (i + 1).toString(),
					read: true,
					write: true
				},
				native: {}
			});
		}
	}

	async _createState_Labels() {
		parentThis.log.info('createStates(): Labels');
		for (let i = 0; i < 8; i++) {
			await this.setObjectAsync('_label_Input_' + (i + 1).toString(), {
				type: 'state',
				common: {
					'def': 'Label for Input #' + (i + 1).toString(),
					'name': 'Label for Input #' + (i + 1).toString(),        // mandatory, default _id ??
					//---Deaktivieren weil neu gesetzt mit jedem Reboot
					//'def': 'In ' + (i + 1).toString(),                     // optional,  default ''
					'type': 'string',               // optional,  default 'string'
					'read': true,                   // mandatory, default true
					'write': true,                  // mandatory, default false
					'role': 'info',   // mandatory
					'desc': 'Label for Input #' + (i + 1).toString()
				},
				native: {}
			});

			await this.setObjectAsync('_label_Output_' + (i + 1).toString(), {
				type: 'state',
				common: {
					'def': 'Label for Output #' + (i + 1).toString(),
					'name': 'Label for Output #' + (i + 1).toString(),        // mandatory, default _id ??
					//'def': 'Out ' + (i + 1).toString(),                     // optional,  default ''
					'type': 'string',               // optional,  default 'string'
					'read': true,                   // mandatory, default true
					'write': true,                  // mandatory, default false
					'role': 'info',   // mandatory
					'desc': 'Label for Output #' + (i + 1).toString()
				},
				native: {}
			});
		}

	}

	async _createState_Save() {
		parentThis.log.info('createStates(): Save');
		await this.setObjectAsync('saveToPreset0', {
			type: 'state',
			common: {
				name: 'save settings to preset 0',
				type: 'boolean',
				role: 'indicator',
				read: true,
				write: true,
			},
			native: {},
		});
	}

	pingMatrix() {
		if ((bConnection == true)/*&&(bWaitingForResponse==false)*/ && (bWaitQueue == false)) {
			if (arrCMD.length == 0) {
				//this.log.debug('pingMatrix()');
				arrCMD.push(cmdConnect);
				iMissedPingCounter = 0;
				if (bFirstPing) {
					//----Ab jetzt nicht mehr
					bFirstPing = false;
					this.setDate();
					this.setInitialPreset();
					this.processExclusiveRoutingStates();
				}
			}
		} else {
			//----No Connection
			//this.log.info('pingMatrix(): No Connection.');
			iMissedPingCounter++;

			if (iMissedPingCounter > 10) {	//7,5 seconds
				this.log.info('pingMatrix(): 10 mal No Connection. Forciere Reconnect');
				parentThis.disconnectMatrix();
				parentThis.initMatrix();
			}

		}
	}

	processCMD() {
		//this.log.debug('processCMD()');
		if (bWaitQueue == false) {
			if (bWaitingForResponse == false) {
				if (arrCMD.length > 0) {
					//this.log.debug('processCMD: bWaitingForResponse==FALSE, arrCMD.length=' + arrCMD.length.toString());
					bWaitingForResponse = true;

					const tmp = arrCMD.shift();
					if (tmp.length == 10) {
						//----Normaler Befehl
						//this.log.debug('processCMD: next CMD=' + toHexString(tmp) + ' arrCMD.length rest=' + arrCMD.length.toString());
						matrix.write(tmp);
						bHasIncomingData = false;
						//lastCMD = tmp;
						//iMaxTryCounter = MAXTRIES;
						if (query) {
							clearTimeout(query);
						}
						query = setTimeout(function () {
							//----5 Sekunden keine Antwort und das Teil ist offline
							if (bHasIncomingData == false) {
								//----Nach x Milisekunden ist noch gar nichts angekommen....
								parentThis.log.error('processCMD(): KEINE EINKOMMENDEN DATEN NACH ' + TIMEOUT.toString() + ' Milisekunden. OFFLINE?');
								bConnection = false;
								parentThis.disconnectMatrix();
								parentThis.initMatrix();
							} else {
								parentThis.log.info('processCMD(): Irgendetwas kam an... es lebt.');
							}
						}, TIMEOUT);

					} else if (tmp.length == 2) {
						const iWait = tmp[0] * 256 + tmp[1];
						bWaitQueue = true;
						this.log.debug('processCMD.waitQueue: ' + iWait.toString());
						setTimeout(function () { bWaitQueue = false; parentThis.log.info('processCMD.waitQueue DONE'); }, iWait);
					} else {
						//----Nix          
					}
				} else {
					//this.log.debug('processCMD: bWaitingForResponse==FALSE, arrCMD ist leer. Kein Problem');
				}
			} else {
				//this.log.debug('AudioMatrix: processCMD: bWaitingForResponse==TRUE. Nichts machen');
			}
		} else {
			//this.log.debug('processCMD: bWaitQueue==TRUE, warten');
		}

		//----Anzeige der Quelength auf der Oberflaeche
		//        this.setStateAsync('queuelength', { val: arrCMD.length, ack: true });
		//
	}


	processIncoming(chunk) {
		//parentThis.log.info('processIncoming(): ' + toHexString(chunk));
		in_msg += toHexString(chunk);
		bHasIncomingData = true; // IrgendETWAS ist angekommen

		if (bWaitingForResponse == true) {
			if (in_msg.length >= 20 && in_msg.includes('5aa5')) {
				const iStartPos = in_msg.indexOf('5aa5');
				if (in_msg.toLowerCase().substring(iStartPos + 16, iStartPos + 18) == '0a') {
					const tmpMSG = in_msg.toLowerCase().substring(iStartPos, iStartPos + 20); //Checksum
					in_msg = in_msg.slice(20); //Die ersten 20 Zeichen abschneiden
					//parentThis.log.info('_processIncoming(); filtered:' + tmpMSG);
					parentThis.parseMSG(tmpMSG);
					//bWaitingForResponse = false;
				} else if (in_msg.toLowerCase().substring(iStartPos + 4, iStartPos + 6) == '11') {
					//----5aa511c2c00000c2c00000c2c00000c2c0...
					//----In der Regel als Antwort auf einen PING
					//parentThis.log.debug('LevelMeter incoming');
					bWaitingForResponse = false;
				} else if (in_msg.toLowerCase().substring(iStartPos + 4, iStartPos + 6) == '12') {
					//----5aa512c2c00000c2c00000c...
					//----In der Regel als Antwort auf einen PING
					//parentThis.log.debug('Sprectrum incoming');
					bWaitingForResponse = false;
				} else {
					//----Irgendwie vergniesgnaddelt. Das ist offenbar egal, weil die Daten erneut gesendet werden
					//parentThis.log.info('AudioMatrix: matrix.on data: Fehlerhafte oder inkomplette Daten empfangen:' + in_msg);
				}
			}
		} else {
			//----Durch die PING-Mechanik kommt hier recht viel an, da muessen wir spaeter drauf schauen.
			//parentThis.log.info('AudioMatrix: matrix.on data(): incomming aber bWaitingForResponse==FALSE; in_msg:' + in_msg);
		}

		if (in_msg.length > 120) {
			//----Just in case
			in_msg = '';
		}
	}


	//----Data coming from hardware
	parseMSG(sMSG) {
		//this.log.info('parseMSG():' + sMSG);
		if (sMSG === toHexString(cmdBasicResponse)) {
			//this.log.info('parseMSG(): Basic Response.');
			bConnection = true;

		} else if (sMSG === toHexString(cmdTransmissionDone)) {
			this.log.info('parseMSG(): Transmission Done.');
			this.processExclusiveRoutingStates();
			this.setState('info.connection', true, true); //Green led in 'Instances'			
			bWaitingForResponse = false;
		} else if (sMSG.startsWith('5aa50700')) {
			//this.log.info('_parseMSG(): received main volume from Matrix.');
			const sHex = sMSG.substring(8, 16);
			let iVal = HexToFloat32(sHex);
			iVal = simpleMap(0, 100, iVal);
			//this.log.info('_parseMSG(): received main volume from Matrix. Processed Value:' + iVal.toString());
			this.setStateAsync('mainVolume', { val: iVal, ack: true });
		} else {
			const sHex = sMSG.substring(4, 6);
			const iVal = parseInt(sHex, 16);
			if (iVal >= 1 && iVal <= 6) {
				//----Input....
				//this.log.info('_parseMSG(): received INPUT Value');
				const sCmd = sMSG.substring(6, 8);
				const iCmd = parseInt(sCmd, 16);
				if (iCmd == 2) {
					//----Gain
					//this.log.info('_parseMSG(): received INPUT Value for GAIN:' + sMSG.substring(8, 16));
					const sValue = sMSG.substring(8, 16);
					let iValue = HexToFloat32(sValue);
					//this.log.info('_parseMSG(): received inputGain from Matrix. Original Value:' + sValue.toString());
					iValue = map(iValue, -40, 0, 0, 100); //this.simpleMap(0, 100, iVal);
					//this.log.info('_parseMSG(): received gain for input ' + (iVal).toString() + ' from Hardware. Processed Value:' + iValue.toString());
					this.setStateAsync('inputGain_' + (iVal).toString(), { val: iValue, ack: true });
				} else if ((iCmd >= 51) && (iCmd <= 58)) {
					//this.log.info('_parseMSG(): received routing info. IN:' + (iVal).toString()  + ' OUT:' + (iCmd-50).toString());
					const sValue = sMSG.substring(8, 16);
					const iValue = HexToFloat32(sValue);
					const bValue = iValue == 0 ? false : true;
					this.log.info('_parseMSG(): received routing info. IN:' + (iVal).toString() + ' OUT:' + (iCmd - 50).toString() + '. State:' + bValue.toString());
					let sID = (0 + (iVal - 1) * 8 + (iCmd - 50 - 1)).toString();
					while (sID.length < 2) sID = '0' + sID;
					this.setStateAsync('routingNode_ID_' + sID + '__IN_' + (iVal).toString() + '_OUT_' + (iCmd - 50).toString(), { val: bValue, ack: true });
					arrRouting[((iVal - 1) * 8 + (iCmd - 50 - 1))] = bValue;
				}
			} else if (iVal >= 7 && iVal <= 14) {
				//----Output....
				//this.log.info('_parseMSG(): received OUTPUT Value');
				const sCmd = sMSG.substring(6, 8);
				const iCmd = parseInt(sCmd, 16);
				if (iCmd == 1) {
					//----Mute
					const sValue = sMSG.substring(8, 16);
					const iValue = HexToFloat32(sValue);
					const bOnOff = (iValue > 0) ? true : false;
					this.log.info('_parseMSG(): received OUTPUT Value for MUTE. Output(Index):' + (iVal - 7).toString() + ' Val:' + bOnOff.toString());
					this.setStateAsync('mute_' + (iVal - 7 + 1).toString(), { val: bOnOff, ack: true });

				} else if (iCmd == 2) {
					//----Gain
					//this.log.info('_parseMSG(): received OUTPUT Value for GAIN:' + sMSG.substring(8, 16));
					const sValue = sMSG.substring(8, 16);
					let iValue = HexToFloat32(sValue);
					//this.log.info('_parseMSG(): received outputGain from Matrix. Original Value:' + sValue.toString());
					iValue = map(iValue, -40, 0, 0, 100); //this.simpleMap(0, 100, iVal);
					//this.log.info('_parseMSG(): received gain for output ' + (iVal - 7).toString() + ' from Hardware. Processed Value:' + iValue.toString());
					this.setStateAsync('outputGain_' + (iVal - 7 + 1).toString(), { val: iValue, ack: true });
					this.setStateAsync('outputGainDisplay_' + (iVal - 7 + 1).toString(), { val: Math.round(iValue), ack: true });
				}
			}
		}
	}


	//----After 'Transmission Done' is received 
	//----We organize the internal states to reflect the hardware's situation.
	processExclusiveRoutingStates() {
		this.log.info('processExclusiveRoutingStates()');

		for (let i = 0; i < 8; i++) {
			let iOnCounter = 0;
			let iID = 0;
			let sIn;
			let sOut;
			let sID;
			for (let o = 0; o < 8; o++) {
				iID = i * 8 + o;
				sID = iID.toString();
				while (sID.length < 2) sID = '0' + sID;
				iOnCounter++;
				sIn = (i + 1).toString();
				sOut = (o + 1).toString();
				if (arrRouting[iID] == true) {
					this.log.info('processExclusiveRoutingStates() State is TRUE for ID ' + iID.toString());
					/*await*/ this.setStateAsync('routingNode_Exclusive_ID_' + sID + '__IN_' + sIn + '_OUT_' + sOut, { val: true, ack: true });
				} else {
					this.log.info('processExclusiveRoutingStates() State is FALSE for ID ' + iID.toString());
					/*await*/ this.setStateAsync('routingNode_Exclusive_ID_' + sID + '__IN_' + sIn + '_OUT_' + sOut, { val: false, ack: true });
				}
			}
			/*
			if (iOnCounter == 1) {
				this.log.info('processExclusiveRoutingStates() setState():' + 'routingNode_Exclusive_ID_' + sID + '__IN_' + sIn + '_OUT_' + sOut);
				await this.setStateAsync('routingNode_Exclusive_ID_' + sID + '__IN_' + sIn + '_OUT_' + sOut, { val: true, ack: true });
			} else {
				this.log.info('processExclusiveRoutingStates(). iOnCounter=' + iOnCounter.toString() + '. Nothing set.');
			}
			*/
		}



	}

	//==================================================================================



	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// The adapters config (in the instance object everything under the attribute 'native') is accessible via
		// this.config:
		//this.log.info('config option1: ' + this.config.option1);
		//this.log.info('config option2: ' + this.config.option2);

		//this.log.info('Config Host:' + this.config.host);
		//this.log.info('Config Port:' + this.config.port);
		this.serPort = this.config.serialPort;

		/*
		For every state in the system there has to be also an object of type state
		Here a simple template for a boolean variable named 'testVariable'
		Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables
		*/
		/*
		await this.setObjectAsync('testVariable', {
			type: 'state',
			common: {
				name: 'testVariable',
				type: 'boolean',
				role: 'indicator',
				read: true,
				write: true,
			},
			native: {},
		});
		*/


		this.createStates();

		// in this template all states changes inside the adapters namespace are subscribed
		this.subscribeStates('*');

		/*
		setState examples
		you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
		*/
		// the variable testVariable is set to true as command (ack=false)
		//await this.setStateAsync('testVariable', true);

		// same thing, but the value is flagged 'ack'
		// ack should be always set to true if the value is received from or acknowledged from the target system
		//await this.setStateAsync('testVariable', { val: true, ack: true });

		// same thing, but the state is deleted after 30s (getState will return null afterwards)
		//await this.setStateAsync('testVariable', { val: true, ack: true, expire: 30 });

		// examples for the checkPassword/checkGroup functions
		let result = await this.checkPasswordAsync('admin', 'iobroker');
		this.log.info('check user admin pw iobroker: ' + result);

		result = await this.checkGroupAsync('admin', 'admin');
		this.log.info('check group user admin group admin: ' + result);

		this.initMatrix();
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.log.info('cleaned everything up...');
			callback();
		} catch (e) {
			callback();
		}
	}

	/**
	 * Is called if a subscribed object changes
	 * @param {string} id
	 * @param {ioBroker.Object | null | undefined} obj
	 */
	onObjectChange(id, obj) {
		if (obj) {
			// The object was changed
			this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
		} else {
			// The object was deleted
			this.log.info(`object ${id} deleted`);
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
			this.changeMatrix(id, state.val, state.ack);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires 'common.message' property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === 'object' && obj.message) {
	// 		if (obj.command === 'send') {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info('send command');

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
	// 		}
	// 	}
	// }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
	// Export the constructor in compact mode
	/**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
	module.exports = (options) => new BtouchAudiomatrixB2008(options);
} else {
	// otherwise start the instance directly
	new BtouchAudiomatrixB2008();
}
