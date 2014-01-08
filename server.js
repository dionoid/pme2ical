var koa = require('koa')
var router = require('koa-router');
var azure = require('azure');
var env = require('node-env-file');
var thunkify = require('thunkify');
var crypto = require('crypto');
var pme2ical = require('./pme2ical');
var request = require('request');
request.post = thunkify(request.post);
request.get = thunkify(request.get);
var zlib = require('zlib');
zlib.unzip = thunkify(zlib.unzip);
zlib.deflate = thunkify(zlib.deflate);

//load missing environment vars
env(__dirname + '/.env');
//fix padding of access key
process.env.AZURE_STORAGE_ACCESS_KEY += '==='.substr(0, (4 - process.env.AZURE_STORAGE_ACCESS_KEY.length % 4) % 4);

//init azure blob service
var blobService = azure.createBlobService();
blobService.getBlobToText = thunkify(blobService.getBlobToText);
blobService.createBlockBlobFromText = thunkify(blobService.createBlockBlobFromText);

//init koa app
var app = koa();
app.use(router(app));

//set up routes
app.get('/gettoken', getToken);
app.get('/planningpme.ics', getPlanningUsingToken); //TODO: token
app.get('/gettokenfor/:name', getTokenForName);
app.get('/refresh', refreshPMEData);
app.listen(process.env.PORT || 8080);

function *getToken() {

    if (!this.header.authorization) return yield write401();

    var buf = new Buffer(this.header.authorization.split(' ')[1], 'base64');
    var creds = buf.toString().split(':');
    var auth = {
        'user': creds[0],
        'pass': creds[1],
        'sendImmediately': true
    };

    var today = new Date().setHours(0, 0, 0, 0);
    var sResourceToPlan = process.env.PME_RESOURCE_PERSONAL || '53248';
    try {
        var pmeData = yield scrapePmeData(auth, today, today, sResourceToPlan);
    } catch(e) {
        if (e.statusCode == 401) return yield write401();
    }

    if (pmeData.value && pmeData.value.YEntities && pmeData.value.YEntities.length === 1) {
        return yield writeTokenMessage(this, pmeData.value.YEntities[0].Id.toString(), process.env.PME2ICAL_CYPHERSECRET);
    }
    else {
        this.body = 'Error: could not find a resource in PlanningPME connected to your login.<br/> \
            Ask ProjectBureau to add you as default resource in PlanningPME.';
    }
}

function *getPlanningUsingToken() {
    if (this.query.token) {
        
        var token = this.query.token.match(/[a-f0-9]+/)[0]; //ignore non-hex chars at end of token
        var mode = this.query.mode || 'event'; //mode (full-day) event or appointment

        var decipher = crypto.createDecipher('aes256', process.env.PME2ICAL_CYPHERSECRET);
        var entityId = parseInt(decipher.update(token, 'hex', 'utf8') + decipher.final('utf8'), 10);
        console.log('Deciphered entityId = ' + entityId);

        //get pme data from azure blob storage
        var pmeData = yield readPmeDataFromStorage();
        this.body = pme2ical(pmeData, entityId, mode);
    }
}

function *getTokenForName() {
    if (!this.params.name || !this.query.secret) return;

    //get pme data from azure blob storage
    var pmeData = yield readPmeDataFromStorage();

    //loop all YEntities and match on name (N parameter)
    var name = this.params.name.replace(/ /g, '').toLowerCase();
    for (var i = 0; i < pmeData.value.YEntities.length; i++) {
        var yEntity = pmeData.value.YEntities[i];
        if (yEntity.N.replace(/ /g, '').toLowerCase() === name) {
            return yield writeTokenMessage(this, yEntity.Id.toString(), this.query.secret);
        }
    }

    //name not found
    this.body = 'Resource "' + name + '" not found in PlanningPME.';
};

function *refreshPMEData() {
    var today = new Date().setHours(0, 0, 0, 0);
    var lookBackDays = 4 * 7;
    var lookAheadDays = 13 * 7;
    var startDate_ms = today - (1000 * 60 * 60 * 24 * lookBackDays);
    var endDate_ms = today + (1000 * 60 * 60 * 24 * lookAheadDays);
    var sResourceHuman = process.env.PME_RESOURCE_ALLHUMAN || '45056';

    //predefined authenticated domain user
    var authPMEUser = {
	    'user': process.env.PME_USERNAME,
	    'pass': process.env.PME_PASSWORD,
	    'sendImmediately': true
    };

    var pmeData = yield scrapePmeData(authPMEUser, startDate_ms, endDate_ms, sResourceHuman);

    var buffer = yield zlib.deflate(JSON.stringify(pmeData));
    yield blobService.createBlockBlobFromText('data', 'pmedata.json.zip.b64', buffer.toString('base64'));

    this.body = 'PME data is refreshed!';
}

function *scrapePmeData(auth, startDate_ms, endDate_ms, sResource) {
    var pmeDomain = process.env.PME_DOMAIN;
    var urlPME = 'https://' + pmeDomain + '/planningpme/webaccess/en/Web/Planning.aspx';
    var urlGetData = 'https://' + pmeDomain + '/planningpme/ajaxpro/WebAccessPlanning,App_Code.zmm34fne.ashx';
    var j = request.jar(); //cookie jar to hold session information
    
    //step 1: open basic planning aspx page to get session-cookie
    var resultAuth = yield request.get({"url": urlPME, "auth": auth, "jar": j});
    if (resultAuth[0].statusCode !== 200) {
        throw resultAuth[0];
    }

    //step 2: call the "GetParameter" method get app-settings, which contain current timezone offset.
    var resultGetParameter = yield request.post(
        {
            "url": urlGetData + "?ts=" + new Date().getTime(),
            "headers": { "X-AjaxPro-Method": "GetParameter" },
            "json": true,
            "jar": j,
            "body": '{ "dt": "/Date(' + new Date().setHours(0, 0, 0, 0) + ')/" }'
        });
    //get time-zone-offset from JSON result
    var tzo = -resultGetParameter[1].value.TZO;

    //step 3: get all PME data from the specified resource-view id (e.g. "all humans" view)
    //build up request parameters
    var getDataParams = {
        "yview": 1,
        "sdate": "/Date(" + startDate_ms + ")/",
        "edate": "/Date(" + endDate_ms + ")/",
        "sResource": sResource,
        "sSkill": "0",
        "sState": "-1",
        "sCustomer": "0",
        "sProject": "0",
        "sSubProject": null,
        "sTask": "NULL",
        "sUnav": "NULL"
    };
    var resultGetDatas = yield request.post(
        {
            "url": urlGetData,
            "headers": { "X-AjaxPro-Method": "GetDatas" },
            "json": true,
            "jar": j,
            "body": getDataParams
        });
    var pmeData = resultGetDatas[1];
    pmeData.TZO = tzo;

    return pmeData;
}

function *writeTokenMessage(koaCtx, yEntityId, secret) {
    var cipher = crypto.createCipher('aes256', secret);
    var encrToken = cipher.update(yEntityId, 'utf8', 'hex') + cipher.final('hex');
    koaCtx.body = 'Your personal token was generated.<br/> \
        Use this url in Outlook as new Internet Calendar Subscription -> webcal://' + koaCtx.host + '/PlanningPME.ics?token=' + encrToken;
}

//gets Pme data from azure blob storage. TODO: maybe put in memory cache
function *readPmeDataFromStorage() {
    //get zipped pmeData
    var pmeText = (yield blobService.getBlobToText('data', 'pmedata.json.zip.b64')).toString();

    //unzip and parse as JSON
    var unzipBuffer = yield zlib.unzip(new Buffer(pmeText, 'base64'));
    return JSON.parse(unzipBuffer.toString());
}

function *write401() {
    this.status = 401;
    this.set('WWW-Authenticate', 'Basic realm=""');
}