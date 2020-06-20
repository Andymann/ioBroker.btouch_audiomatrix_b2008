"use strict";

/*
 * Created with @iobroker/create-adapter v1.25.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");

//----https://gist.github.com/Jozo132/2c0fae763f5dc6635a6714bb741d152f
const Float32ToHex = (float32) => {
	const getHex = (i) => ("00" + i.toString(16)).slice(-2);
	const view = new DataView(new ArrayBuffer(4));
	view.setFloat32(0, float32);
	return Array.apply(null, { length: 4 })
		.map((_, i) => getHex(view.getUint8(i)))
		.join("");
};

const Float32ToBin = (float32) => parseInt(Float32ToHex(float32), 16).toString(2).padStart(32, "0");
const conv754 = (float32) => {
	const getHex = (i) => parseInt(("00" + i.toString(16)).slice(-2), 16);
	const view = new DataView(new ArrayBuffer(4));
	view.setFloat32(0, float32);
	return Array.apply(null, { length: 4 }).map((_, i) => getHex(view.getUint8(i)));
};

const ToFloat32 = (num) => {
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

const HexToFloat32 = (str) => ToFloat32(parseInt(str, 16));
const BinToFloat32 = (str) => ToFloat32(parseInt(str, 2));

//https://gist.github.com/xposedbones/75ebaef3c10060a3ee3b246166caab56
//---- Wert, IN von, IN bis, OUT von, OUT bis
const map = (value, x1, y1, x2, y2) => ((value - x1) * (y2 - x2)) / (y1 - x1) + x2;

// Load your modules here, e.g.:
// const fs = require("fs");
const net = require("net");
let matrix = null;
let pingInterval = null;
let cmdInterval = null;
let query = null;
let bConnection = false;
let bWaitingForResponse = false;
let bQueryDone = false;
let bQueryInProgress = false;
let bHasIncomingData = false; //Irgendetwas kommt herein

//----Wir koennen einmalig nach einem erfolgreichen Connect etwas machen
let bFirstPing = true;

let iMaxTryCounter = 0;
const iMaxTimeoutCounter = 0;
const arrCMD = [];
let lastCMD;
let in_msg = "";
let parentThis;
const cmdConnect = new Buffer([0x5a, 0xa5, 0x14, 0x00, 0x40, 0x00, 0x00, 0x00, 0x0a, 0x5d]);
const cmdBasicResponse = new Buffer([0x5a, 0xa5, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0x0a, 0xa9]);
const cmdTransmissionDone = new Buffer([0x5a, 0xa5, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0xf1, 0x0a, 0xaf]);

const cmdVol100 = new Buffer([0x5a, 0xa5, 0x07, 0x00, 0x42, 0xc8, 0x00, 0x00, 0x0a, 0x1a]);
const cmdVol075 = new Buffer([0x5a, 0xa5, 0x07, 0x00, 0x42, 0x96, 0x00, 0x00, 0x0a, 0xe8]);
const cmdVol050 = new Buffer([0x5a, 0xa5, 0x07, 0x00, 0x42, 0x48, 0x00, 0x00, 0x0a, 0x9a]);
const cmdVol025 = new Buffer([0x5a, 0xa5, 0x07, 0x00, 0x41, 0xc8, 0x00, 0x00, 0x0a, 0x19]);
const cmdVol000 = new Buffer([0x5a, 0xa5, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x10]);

const cmdRouting = new Buffer([0x5a, 0xa5, 0x01, 0x33, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x10]);

//----Interne Verwendung
const cmdWaitQueue_200 = new Buffer([0x00, 0xc8]);
const cmdWaitQueue_1000 = new Buffer([0x03, 0xe8]);

const MAXTRIES = 3;
const PINGINTERVALL = 1000;
const BIGINTERVALL = 10000;
const SMALLINTERVALL = 333;
const OFFLINETIMER = 3500;

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

	toHexString(byteArray) {
		return Array.from(byteArray, function (byte) {
			return ("0" + (byte & 0xff).toString(16)).slice(-2);
		}).join("");
	}

	//----Hex-representing chars to array containing hex values
	toArray(response) {
		const chunks = [];
		for (let i = 0, charsLength = response.length; i < charsLength; i += 2) {
			chunks.push(parseInt(response.substring(i, i + 2), 16));
		}
		return chunks;
	}

	//----Gibt den Array mit korrekter Checksumme zurueck
	convertArray(array) {
		const tmpArr = array.slice();

		let tmpChk = 0;
		for (let i = 0; i < array.length - 1; i++) {
			tmpChk += array[i];
		}
		tmpChk = tmpChk & 0xff;
		tmpArr[tmpArr.length - 1] = tmpChk;
		return tmpArr;
	}

	compareArray(pArr1, pArr2) {
		bReturn = false;
		if (pArr1.length == pArr2.length) {
			for (i = 0; i < pArr1.length; i++) {
				if (pArr1[i] != pArr2[i]) {
					break;
				}
				bReturn = true;
			}
		}
		return bReturn;
	}

	initMatrix() {
		this.log.info("initMatrix().");
		this.connectMatrix();
	}

	pingMatrix() {
		if (bConnection == true) {
			if (arrCMD.length == 0) {
				this.log.info("pingMatrix()");
				arrCMD.push(cmdConnect);
				//this.processCMD();
				//bWaitingForResponse=false;
				if (bFirstPing) {
					//----Ab jetzt nicht mehr
					bFirstPing = false;
					this.setDate();
					//this.setRouting();
				}
			}
		} else {
		}
	}

	queryMatrix() {
		this.log.info("AudioMatrix: queryMatrix(). TBD.  arrCMD.length vorher=" + arrCMD.length.toString());
		//        bQueryInProgress  = true;
		//		this.setState('queryState', true, true);
		//        arrQuery.forEach(function(item, index, array) {
		//            arrCMD.push(item);
		//        });
		//        this.log.info('AudioMatrix: queryMatrix(). arrCMD.length hinterher=' + arrCMD.length.toString());
		//        iMaxTryCounter = 3;
		//        this.processCMD();
	}

	reconnect() {
		this.log.info("AudioMatrix: reconnectMatrix(). TBD");
		//		bFirstPing=true;
		//        bConnection = false;
		//        clearInterval(query);
		//        clearTimeout(recnt);
		//        matrix.destroy();

		//        this.log.info('AudioMatrix: Reconnect after 15 sec...');
		//        this.setState('info.connection', false, true);
		//this.setConnState(false, false);
		//        recnt = setTimeout(function() {
		//            parentThis.initmatrix();
		//        }, 15000);
	}

	_connect() {
		this.log.info("_connect()");
		if (bConnection == false) {
			parentThis.log.info("_connect().connection==false, sending CMDCONNECT:" + parentThis.toHexString(cmdConnect));
			arrCMD.push(cmdConnect);
			//iMaxTryCounter = MAXTRIES;
			//        	parentThis.processCMD();
		} else {
			parentThis.log.debug("_connect().bConnection==true. Nichts tun");
			//----Bei der 880er koennten wir etwas tun, hier nicht unbedingt
		}

		//----Die verschiedenen Probleme rund um den Connect werden hier verarbeitet
		//setTimeout(function(){ parentThis._connectionHandler }, SMALLINTERVALL);
	}

	/*
		Alle Befehle werden in arrCMD[] gespeichert. Die Methode arbeitet den naechsten Befehl ab.	
	*/
	processCMD() {
		var bWait = false;
		//this.log.info("processCMD()");
		if (bWaitingForResponse == false) {
			if (arrCMD.length > 0) {
				//this.log.info('processCMD: bWaitingForResponse==FALSE, arrCMD.length=' +arrCMD.length.toString());
				bWaitingForResponse = true;
				//if(bWait==false){
				const tmp = arrCMD.shift();
				if (tmp.length == 10) {
					//----Normaler Befehl
					this.log.info("processCMD: next CMD=" + this.toHexString(tmp) + " arrCMD.length rest=" + arrCMD.length.toString());
					lastCMD = tmp;
					iMaxTryCounter = MAXTRIES;
					matrix.write(tmp);
					bHasIncomingData = false;
					clearTimeout(query);
					query = setTimeout(function () {
						//----Es ist ander als bei der 880er: 2 Sekunden keine Antwort und das Teil ist offline
						if (bHasIncomingData == false) {
							//----Nach x Milisekunden ist noch gar nichts angekommen....
							parentThis.log.error("processCMD(): KEINE EINKOMMENDEN DATEN NACH ... Milisekunden. OFFLINE?");
							clearInterval(pingInterval);
							bWaitingForResponse = false;
							parentThis.reconnect();
						} else {
							//parentThis.log.info("processCMD(): Irgendetwas kam an... es lebt.");
						}
					}, OFFLINETIMER);
				} else if (tmp.length == 2) {
					//----WaitQueue, Der Wert entspricht den zu wartenden Milisekunden
					const iWait = tmp[0] * 256 + tmp[1];
					this.log.info("processCMD.waitQueue: " + iWait.toString());
					//bWait=true;
					//setTimeout(function(){ bWait=false; parentThis.log.info('processCMD.waitQueue DONE'); }, iWait);
				} else {
					//----Nix
					this.log.info("UKU");
				}
				//}else{
				//	this.log.info('bWait==TRUE');
				//}
			}
			//else{
			//    this.log.debug('AudioMatrix: processCMD: bWaitingForResponse==FALSE, arrCMD ist leer. Kein Problem');
			//}
		} else {
			this.log.info("AudioMatrix: processCMD: bWaitingForResponse==TRUE. Nichts machen");
		}

		//----Anzeige der Quelength auf der Oberflaeche
		//        this.setStateAsync('queuelength', { val: arrCMD.length, ack: true });
	}

	_processIncoming(chunk) {
		//parentThis.log.info("_processIncoming(): " + parentThis.toHexString(chunk) );
		in_msg += parentThis.toHexString(chunk);
		bHasIncomingData = true; // IrgendETWAS ist angekommen
		if (bWaitingForResponse == true) {
			if (in_msg.length >= 20 && in_msg.includes("5aa5")) {
				const iStartPos = in_msg.indexOf("5aa5");
				if (in_msg.toLowerCase().substring(iStartPos + 16, iStartPos + 18) == "0a") {
					const tmpMSG = in_msg.toLowerCase().substring(iStartPos, iStartPos + 20); //Checksum
					in_msg = in_msg.slice(20); //Die ersten 20 Zeichen abschneiden
					//parentThis.log.info('_processIncoming(); filtered:' + tmpMSG);
					//					parentThis.bWaitingForResponse = false;
					parentThis._parseMSG(tmpMSG);

					lastCMD = "";
					//iMaxTryCounter = 3;
					//					iMaxTimeoutCounter = 0;
					//					parentThis.processCMD();
				} else if (in_msg.toLowerCase().substring(iStartPos + 4, iStartPos + 6) == "11") {
					//----5aa511c2c00000c2c00000c2c00000c2c0...
					//----In der Regel als Antwort auf einen PING
					//parentThis.log.info("LevelMeter incoming");
					bWaitingForResponse = false;
				} else if (in_msg.toLowerCase().substring(iStartPos + 4, iStartPos + 6) == "12") {
					//----5aa512c2c00000c2c00000c...
					//----In der Regel als Antwort auf einen PING
					//parentThis.log.info("Sprectrum incoming");
					bWaitingForResponse = false;
				} else {
					//----Irgendwie vergniesgnaddelt
					parentThis.log.info("AudioMatrix: matrix.on data: Fehlerhafte oder inkomplette Daten empfangen:" + in_msg);
				}
			}
		} else {
			//----Durch die PING-Mechanik kommt hier recht viel an, da muessen wir spaeter drauf schauen.
			//parentThis.log.info('AudioMatrix: matrix.on data(): incomming aber bWaitingForResponse==FALSE; in_msg:' + in_msg);
		}

		if (in_msg.length > 120) {
			//----Just in case
			in_msg = "";
		}
	}

	//----Rudimentaere Funktion, um syntaktisch prinzipiell korrekte Werte sichezustellen
	simpleMap(pMinimal, pMaximal, pVal) {
		if (pVal < pMinimal) {
			pVal = pMinimal;
		} else if (pVal > pMaximal) {
			pVal = pMaximal;
		}
		return pVal;
	}

	//----Daten komen von der HArdware an
	_parseMSG(sMSG) {
		this.log.info("_parseMSG():" + sMSG);
		if (sMSG === this.toHexString(cmdBasicResponse)) {
			this.log.info("_parseMSG(): Basic Response.");
			//this.bConnection=true;
		} else if (sMSG === this.toHexString(cmdTransmissionDone)) {
			this.log.info("_parseMSG(): Transmission Done.");
			bConnection = true;
			bQueryDone = true;
			bQueryInProgress = false;
			bWaitingForResponse = false;
		} else if (sMSG.startsWith("5aa50700")) {
			this.log.info("_parseMSG(): received main volume from Matrix.");
			const sHex = sMSG.substring(8, 16);
			let iVal = HexToFloat32(sHex);
			iVal = this.simpleMap(0, 100, iVal);
			this.log.info("_parseMSG(): received main volume from Matrix. Processed Value:" + iVal.toString());
			this.setStateAsync("mainVolume", { val: iVal, ack: true });
		} else {
			const sHex = sMSG.substring(4, 2);
			const iVal = HexToFloat32(sHex);
			if (iVal >= 1 && iVal <= 6) {
				//----Input....
				const sCmd = sMSG.substring(6, 2);
				const iCmd = HexToFloat32(sCmd);
				if (iCmd == 2) {
					//----Gain
					const sValue = sMSG.substring(8, 16);
					let iValue = HexToFloat32(sHex);
					iValue = map(iValue, -80, 0, 0, 100); //this.simpleMap(0, 100, iVal);
					this.log.info("_parseMSG(): received inputGain from Matrix. Processed Value:" + iValue.toString());
					this.setStateAsync("inputGain", { val: iValue, ack: true });
				}
			} else if (iVal >= 7 && iVal <= 14) {
				//----Output....
				const sCmd = sMSG.substring(6, 2);
				const iCmd = HexToFloat32(sCmd);
				if (iCmd == 2) {
					//----Gain
					const sValue = sMSG.substring(8, 16);
					let iValue = HexToFloat32(sHex);
					iValue = map(iValue, -80, 0, 0, 100); //this.simpleMap(0, 100, iVal);
					this.log.info("_parseMSG(): received outputGain from Matrix. Processed Value:" + iValue.toString());
					this.setStateAsync("outputGain", { val: iValue, ack: true });
				}
			}
		}
	}

	connectMatrix(cb) {
		this.log.info("connectMatrix():" + this.config.host + ":" + this.config.port);

		bFirstPing = true;
		bQueryDone = false;
		bQueryInProgress = false;
		bWaitingForResponse = false;

		matrix = new net.Socket();
		matrix.connect(this.config.port, this.config.host, function () {
			clearInterval(pingInterval);
			parentThis._connect();
			//query = setInterval(function(){parentThis._connect()}, BIGINTERVALL);
			pingInterval = setInterval(function () {
				parentThis.pingMatrix();
			}, PINGINTERVALL);

			//----Queue
			clearInterval(cmdInterval);
			cmdInterval = setInterval(function () {
				parentThis.processCMD();
			}, 50);

			if (cb) {
				cb();
			}
		});

		matrix.on("data", function (chunk) {
			//parentThis.log.info("matrix.onData(): " + parentThis.toHexString(chunk) );
			parentThis._processIncoming(chunk);
		});

		matrix.on("timeout", function (e) {
			//if (e.code == "ENOTFOUND" || e.code == "ECONNREFUSED" || e.code == "ETIMEDOUT") {
			//            matrix.destroy();
			//}
			parentThis.log.error("AudioMatrix TIMEOUT. TBD");
			//parentThis.connection=false;
			//parentThis.setConnState(false, true);
			//            parentThis.reconnect();
		});

		matrix.on("error", function (e) {
			if (e.code == "ENOTFOUND" || e.code == "ECONNREFUSED" || e.code == "ETIMEDOUT") {
				matrix.destroy();
			}
			parentThis.log.error(e);
			//            parentThis.reconnect();
		});

		matrix.on("close", function (e) {
			if (bConnection) {
				parentThis.log.error("AudioMatrix closed. TBD");
			}
			//parentThis.reconnect();
		});

		matrix.on("disconnect", function (e) {
			parentThis.log.error("AudioMatrix disconnected. TBD");
			//            parentThis.reconnect();
		});

		matrix.on("end", function (e) {
			parentThis.log.error("AudioMatrix ended");
			//parentThis.setConnState(false, true);
		});
	}

	//----Aufruf aus onReady. Hier wird angelegt, was spaeter gesteuert werden kann
	async createStates() {
		this._createState_mainVolume();
		this._createState_Routing();
		this._createState_inputGain();
		this._createState_outputGain();
	}

	async _createState_mainVolume() {
		parentThis.log.info("createStates(): mainVolume");
		await this.setObjectAsync("mainVolume", {
			type: "state",
			common: {
				name: "Main Volume",
				type: "number",
				role: "level.volume",
				read: true,
				write: true,
				desc: "Main Volume",
				min: 0,
				max: 100,
			},
			native: {},
		});
	}

	async _createState_inputGain() {
		parentThis.log.info("createStates(): inputGain");
		for (let inVal = 0; inVal < 8; inVal++) {
			await this.setObjectAsync("inputGain_" + (inVal + 1).toString(), {
				type: "state",
				common: {
					name: "Input Gain " + (inVal + 1).toString(),
					type: "number",
					role: "level.volume",
					read: true,
					write: true,
					desc: "Input Gain " + (inVal + 1).toString(),
					min: 0,
					max: 100,
				},
				native: {},
			});
		}
	}

	async _createState_outputGain() {
		parentThis.log.info("createStates(): outputGain");
		for (let outVal = 0; outVal < 8; outVal++) {
			await this.setObjectAsync("outputGain_" + (outVal + 1).toString(), {
				type: "state",
				common: {
					name: "Output Gain " + (outVal + 1).toString(),
					type: "number",
					role: "level.volume",
					read: true,
					write: true,
					desc: "Output Gain" + (outVal + 1).toString(),
					min: 0,
					max: 100,
				},
				native: {},
			});
		}
	}

	async _createState_Routing() {
		parentThis.log.info("createStates(): Routing");
		for (let inVal = 0; inVal < 8; inVal++) {
			for (let outVal = 0; outVal < 8; outVal++) {
				//await this.setObjectAsync('routingNode_' + ((in*8 + out)+1).toString(), {
				let sID = inVal * 8 + outVal + "";
				while (sID.length < 2) sID = "0" + sID;

				await this.setObjectAsync("routingNode_ID_" + sID + "__IN_" + (inVal + 1).toString() + "_OUT_" + (outVal + 1).toString(), {
					type: "state",
					common: {
						name: "Routing " + (inVal + 1).toString() + " -> " + (outVal + 1).toString(),
						type: "boolean",
						role: "indicator",
						desc: "Routing " + (inVal + 1).toString() + " -> " + (outVal + 1).toString(),
						read: true,
						write: true,
					},
					native: {},
				});
			}
		}
	}

	testConversion() {
		const value = 100; // JS number variable
		// FLOAT32 <===> HEX
		const f32_hex = Float32ToHex(value); // JS number   =>   HEX string of a Float32 standard number
		const f32_hex_inverse = HexToFloat32(f32_hex); // HEX string of a Float32 standard number   =>   JS number

		// FLOAT32 <===> BIN
		const f32_bin = Float32ToBin(value); // JS number   =>   HEX string of a Float32 standard number
		const f32_bin_inverse = BinToFloat32(f32_bin); // HEX string of a Float32 standard number   =>   JS number

		parentThis.log.info(`Input value (${value}) => hex (${f32_hex}) [${Math.ceil(f32_hex.length / 2)} bytes] => float32 (${f32_bin_inverse})`);
		parentThis.log.info(`Input value (${value}) => binary (${f32_bin}) [${f32_bin.length} bits] => float32 (${f32_bin_inverse})`);

		parentThis.log.info("testConversion():" + f32_hex.toString());
		parentThis.log.info("testConversion() len:" + parentThis.toArray(f32_hex.toString()).length.toString());
		parentThis.log.info(
			"testConversion() content:" +
			parentThis.toArray(f32_hex.toString())[0].toString() +
			"." +
			parentThis.toArray(f32_hex.toString())[1].toString() +
			"." +
			parentThis.toArray(f32_hex.toString())[2].toString() +
			"." +
			parentThis.toArray(f32_hex.toString())[3].toString() +
			"."
		);
	}

	//----Ein State wurde per GUI veraendert
	changeMatrix(id, val, ack) {
		if (bConnection && val && !val.ack) {
			//this.log.info('matrixChanged: tabu=TRUE' );
			//tabu = true;
		}

		this.log.info("changeMatrix: ID:" + id.toString());
		this.log.info("changeMatrix: VAL:" + val.toString());
		this.log.info("changeMatrix: ACK:" + ack.toString());

		if (ack == false) {
			//----Aenderung ueber die GUI
			//this.log.info('changeMatrix: per GUI. ID:' + id.toString() );
			if (id.toUpperCase().endsWith("MAINVOLUME")) {
				this._changeMainVolume(val);
			} else if (id.toUpperCase().includes("ROUTINGNODE_ID_")) {
				let sTemp = id.substring(id.indexOf("ID_") + 3);
				sTemp = sTemp.substring(0, 2);
				sTemp = sTemp.trim();
				var idVal = parseInt(sTemp);
				const iIn = (idVal - (idVal % 8)) / 8;
				const iOut = idVal - iIn * 8;
				//----Ein- und Ausgang sind jetzt 0-indiziert
				this._changeRouting(iIn, iOut, val);
			} else if (id.toUpperCase().includes("INPUTGAIN_")) {
				//----Die ID des InputGains ist einstellig
				var sID = id.substring(id.toUpperCase().indexOf("GAIN_") + 5);
				//sID = sID.substring(0, 1);
				sID = sID.trim();
				var idVal = parseInt(sID);
				idVal -= 1;

				//----0-indiziert
				this._changeInputGain(idVal, val);
			} else if (id.toUpperCase().includes("OUTPUTGAIN_")) {
				//----Die ID des OutputGains ist einstellig
				var sID = id.substring(id.toUpperCase().indexOf("GAIN_") + 5);
				//sID = sID.substring(0, 1);
				sID = sID.trim();
				var idVal = parseInt(sID);
				idVal -= 1;

				//----0-indiziert
				this._changeOutputGain(idVal, val);
			}
		}
	}

	_changeMainVolume(val) {
		this.log.info("changeMainVolume via GUI: VAL:" + val.toString());
		const arrVal = conv754(val);
		let tmpCMD = cmdVol000.slice();
		tmpCMD[4] = arrVal[0];
		tmpCMD[5] = arrVal[1];
		tmpCMD[6] = arrVal[2];
		tmpCMD[7] = arrVal[3];

		//----Checksumme korrigieren
		tmpCMD = this.convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
		//parentThis.processCMD();
	}

	//---- pID: 0..7
	//---- pVal: 0..100
	_changeInputGain(pID, pVal) {
		this.log.info("changeInputGain via GUI. ID(Index):" + pID.toString() + " VAL:" + pVal.toString());
		if (pID >= 0 && pID < 7) {
			pVal = map(pVal, 0, 100, -80, 0);
			this.log.info("changeInputGain via GUI: VAL(neu):" + pVal.toString());
			const arrVal = conv754(pVal);
			let tmpCMD = new Buffer([0x5a, 0xa5, 0x01 /* Input number */, 0x02 /* Gain */, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x10]);

			tmpCMD[2] = pID + 1;
			tmpCMD[4] = arrVal[0];
			tmpCMD[5] = arrVal[1];
			tmpCMD[6] = arrVal[2];
			tmpCMD[7] = arrVal[3];

			//----Checksumme korrigieren
			tmpCMD = this.convertArray(tmpCMD);
			this.log.info("changeInputGain(): adding:" + this.toHexString(tmpCMD));
			arrCMD.push(tmpCMD);
		} else {
			this.log.error("changeInputGain() via GUI: Coax inputs are not supported");
		}
	}

	//---- pID: 0..7
	//---- pVal: 0..100
	_changeOutputGain(pID, pVal) {
		this.log.info("changeOutputGain via GUI. ID(Index):" + pID.toString() + " VAL:" + pVal.toString());
		pVal = map(pVal, 0, 100, -80, 0);
		this.log.info("changeOutputGain via GUI: VAL(neu):" + pVal.toString());
		const arrVal = conv754(pVal);
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x01 /* Input number */, 0x02 /* Gain */, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x10]);

		tmpCMD[2] = pID + 7;
		tmpCMD[4] = arrVal[0];
		tmpCMD[5] = arrVal[1];
		tmpCMD[6] = arrVal[2];
		tmpCMD[7] = arrVal[3];

		//----Checksumme korrigieren
		tmpCMD = this.convertArray(tmpCMD);
		this.log.info("changeOutputGain(): adding:" + this.toHexString(tmpCMD));
		arrCMD.push(tmpCMD);
	}

	//----IN: 0-7
	//----OUT:0-8
	//----pOnOff: TRUE / FALSE
	_changeRouting(pIn, pOut, pOnOff) {
		this.log.info("changeRouting() via GUI: In(Index):" + pIn.toString() + " Out(Index):" + pOut.toString() + " pOnOff:" + pOnOff.toString());
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

			//----Checksumme korrigieren
			tmpCMD = this.convertArray(tmpCMD);
			this.log.info("changeRouting(): adding:" + this.toHexString(tmpCMD));
			arrCMD.push(tmpCMD);
		} else {
			this.log.error("changeRouting() via GUI: Coax inputs are not supported");
		}
		//this.log.info('changeRouting(): last CMD in arrCMD:' + this.toHexString( arrCMD[arrCMD.length-1] ) );
	}

	//----Sendet die Befehle zum Setzen des korrekten Datums an die Matrix
	setDate() {
		this.log.info("setDate()");
		this._setHardwareDate_year();
		this._setHardwareDate_month();
		this._setHardwareDate_day();
		this._setHardwareDate_hour();
		this._setHardwareDate_minute();
		//parentThis.processCMD();
	}

	//----Test
	setRouting() {
		this.log.info("setRouting()");
		this._changeRouting(1, 1, false);
		this._changeRouting(2, 2, false);
		this._changeRouting(3, 3, false);
		this._changeRouting(4, 4, false);
		this._changeRouting(5, 5, false);
		this._changeRouting(6, 6, false);
	}

	_setHardwareDate_year() {
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d]);

		const yyyy = new Date().getFullYear();
		const year = conv754(yyyy /*-1970*/);
		//----Jahr
		tmpCMD[3] = 0x12;
		tmpCMD[4] = year[0];
		tmpCMD[5] = year[1];
		tmpCMD[6] = year[2];
		tmpCMD[7] = year[3];

		//----Checksumme korrigieren
		tmpCMD = this.convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
		//parentThis.processCMD();
	}

	_setHardwareDate_month() {
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d]);

		const mm = new Date().getMonth() + 1;
		const month = conv754(mm);
		//----Jahr
		tmpCMD[3] = 0x13;
		tmpCMD[4] = month[0];
		tmpCMD[5] = month[1];
		tmpCMD[6] = month[2];
		tmpCMD[7] = month[3];

		//----Checksumme korrigieren
		tmpCMD = this.convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
		//parentThis.processCMD();
	}

	_setHardwareDate_day() {
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d]);

		const dd = new Date().getDate();
		const day = conv754(dd);
		//----Jahr
		tmpCMD[3] = 0x14;
		tmpCMD[4] = day[0];
		tmpCMD[5] = day[1];
		tmpCMD[6] = day[2];
		tmpCMD[7] = day[3];

		//----Checksumme korrigieren
		tmpCMD = this.convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
		//parentThis.processCMD();
	}

	_setHardwareDate_hour() {
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d]);

		const hh = new Date().getHours();
		const hour = conv754(hh);
		//----Jahr
		tmpCMD[3] = 0x15;
		tmpCMD[4] = hour[0];
		tmpCMD[5] = hour[1];
		tmpCMD[6] = hour[2];
		tmpCMD[7] = hour[3];

		//----Checksumme korrigieren
		tmpCMD = this.convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
		//parentThis.processCMD();
	}

	_setHardwareDate_minute() {
		let tmpCMD = new Buffer([0x5a, 0xa5, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d]);

		const mm = new Date().getMinutes();
		const minute = conv754(mm);
		//----Jahr
		tmpCMD[3] = 0x16;
		tmpCMD[4] = minute[0];
		tmpCMD[5] = minute[1];
		tmpCMD[6] = minute[2];
		tmpCMD[7] = minute[3];

		//----Checksumme korrigieren
		tmpCMD = this.convertArray(tmpCMD);

		arrCMD.push(tmpCMD);
		//parentThis.processCMD();
	}

	/**
   * Is called when databases are connected and adapter received configuration.
   */
	async onReady() {
		// Initialize your adapter here

		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		//this.log.info("config option1: " + this.config.option1);
		//this.log.info("config option2: " + this.config.option2);

		this.log.info("Config Host:" + this.config.host);
		this.log.info("Config Port:" + this.config.port);
		/*
		For every state in the system there has to be also an object of type state
		Here a simple template for a boolean variable named "testVariable"
		Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables
		*/
		await this.setObjectAsync("testVariable", {
			type: "state",
			common: {
				name: "testVariable",
				type: "boolean",
				role: "indicator",
				read: true,
				write: true,
			},
			native: {},
		});

		//----
		this.createStates();

		this.testConversion();

		// in this template all states changes inside the adapters namespace are subscribed
		this.subscribeStates("*");

		/*
		setState examples
		you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
		*/
		// the variable testVariable is set to true as command (ack=false)
		await this.setStateAsync("testVariable", true);

		// same thing, but the value is flagged "ack"
		// ack should be always set to true if the value is received from or acknowledged from the target system
		await this.setStateAsync("testVariable", { val: true, ack: true });

		// same thing, but the state is deleted after 30s (getState will return null afterwards)
		await this.setStateAsync("testVariable", {
			val: true,
			ack: true,
			expire: 30,
		});

		// examples for the checkPassword/checkGroup functions
		let result = await this.checkPasswordAsync("admin", "iobroker");
		this.log.info("check user admin pw ioboker: " + result);

		result = await this.checkGroupAsync("admin", "admin");
		this.log.info("check group user admin group admin: " + result);

		//----
		this.initMatrix();
	}

	/**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
	onUnload(callback) {
		try {
			this.log.info("cleaned everything up...");
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
	//  * Using this method requires "common.message" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === "object" && obj.message) {
	// 		if (obj.command === "send") {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info("send command");

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
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
