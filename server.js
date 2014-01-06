// http://zef.me/6096/callback-free-harmonious-node-js
// http://blog.stevensanderson.com/2013/12/21/experiments-with-koa-and-javascript-generators/

var koa = require('koa')
var router = require('koa-router');
var azure = require('azure');
var env = require('node-env-file');
var thunkify = require('thunkify');
var crypto = require('crypto');
var zlib = require('zlib');
zlib.unzip = thunkify(zlib.unzip);

//load missing environment vars
env(__dirname + '/.env');
//fix padding of access key
process.env.AZURE_STORAGE_ACCESS_KEY += '==='.substr(0, (4 - process.env.AZURE_STORAGE_ACCESS_KEY.length % 4) % 4);

//init azure blob service
var blobService = azure.createBlobService();
blobService.getBlobToText = thunkify(blobService.getBlobToText);

//init koa app
var app = koa();
app.use(router(app));

//set up routes
app.get('/gettokenfor/:name', getTokenForName);
app.listen(process.env.PORT || 8080);

function *getTokenForName() {
    //get pme data from azure blob storage
    var pmeData = yield getPmeData();

    //loop all YEntities and match on name (N parameter)
    var name = this.params.name.toLowerCase();
    var found = false;
    for (var i = 0; i < pmeData.value.YEntities.length; i++) {
        var yEntity = pmeData.value.YEntities[i];
        if (yEntity.N.replace(/ /g, "").toLowerCase() === name) {
            var encrToken = encrypt2hex(yEntity.Id.toString());
            this.body = "Your personal token was generated.<br/> \
                Use this url in Outlook as new Internet Calendar Subscription -> webcal://" + this.host + "/PlanningPME.ics?token=" + encrToken;
            found = true; break;
        }
    }
    if (!found) {
        this.body = "Resource '" + name + "' not found in PlanningPME.";
    }
};

//gets Pme data from azure blob storage
function *getPmeData() {
    //get zipped pmeData
    var pmeText = (yield blobService.getBlobToText('data', 'pme.json.zip.b64')).toString();

    //unzip and parse as JSON
    var unzipBuffer = yield zlib.unzip(new Buffer(pmeText, 'base64'));
    return JSON.parse(unzipBuffer.toString());
}

//encrypt text using internal cyphersecret
function encrypt2hex(text) {
    var cipher = crypto.createCipher('aes256', process.env.PME2ICAL_CYPHERSECRET);
    return cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
}

//function getBlobToText2(container, blob) {
//    return function(callback) { blobService.getBlobToText(container, blob, callback); };
//}

//1a. var pmeResults = JSON.parse(yield unzipBase64(pmeBlob.text));
//unzip base64 encoded zipped data
//function unzipBase64(data) {
//    var deferred = Q.defer();
//    var buffer = new Buffer(data, 'base64');
//    zlib.unzip(buffer, function (err, buffer) {
//        deferred.resolve(buffer.toString());
//    });
//    return deferred.promise;
//}
//        if (err) deferred.reject();

//1b. var pmeResults = JSON.parse((yield unzipBase64ToBuffer(pmeBlob.text)).toString());
// [thunk] unzip base64 encoded zipped data to a buffer
//function unzipBase64ToBuffer(data) {
//    var buffer = new Buffer(data, 'base64');
//    return function(callback) { zlib.unzip(buffer, callback); };
//}
