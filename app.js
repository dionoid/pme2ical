var http = require('http');
var url = require('url');
var request = require('request');
//var cache = require('memory-cache');
var pme2ical = require('./pme2ical');
var azure = require('azure');
var crypto = require('crypto');
var zlib = require('zlib');

//parse cli arguments (used for local development)
var cli_arguments = {};
for (var index = 0; index < process.argv.length; index++) {
    var re = new RegExp('--([A-Za-z0-9_]+)=(.+)');
    var matches = re.exec(process.argv[index]);
    if(matches !== null) {
        cli_arguments[matches[1]] = matches[2];
    }
}

/**********************/
/* configuration vars */
/**********************/
var pmeDomain = process.env.PME_DOMAIN || cli_arguments.PME_DOMAIN;
var urlPME = 'https://' + pmeDomain + '/planningpme/webaccess/en/Web/Planning.aspx';
var urlGetData = 'https://' + pmeDomain + '/planningpme/ajaxpro/WebAccessPlanning,App_Code.zmm34fne.ashx';
var lookDaysBack = 4 * 7;
var lookDaysAhead = 13 * 7;
var sResourceHuman = process.env.PME_RESOURCE_ALLHUMAN || cli_arguments.PME_RESOURCE_ALLHUMAN || '45056';
var sResourceToPlan = process.env.PME_RESOURCE_PERSONAL || cli_arguments.PME_RESOURCE_PERSONAL || '53248';
var cyphersecret = process.env.PME2ICAL_CYPHERSECRET || cli_arguments.PME2ICAL_CYPHERSECRET;
var authPMEUser = {
	'user': process.env.PME_USERNAME || cli_arguments.PME_USERNAME,
	'pass': process.env.PME_PASSWORD || cli_arguments.PME_PASSWORD,
	'sendImmediately': true
};
var blobAccount = process.env.AZURE_STORAGE_ACCOUNT || cli_arguments.AZURE_STORAGE_ACCOUNT;
var blobKey = process.env.AZURE_STORAGE_ACCESS_KEY || cli_arguments.AZURE_STORAGE_ACCESS_KEY;


http.createServer(function (httpRequest, httpResponse) {

    console.log("==> Requested url: " + httpRequest.url);
    
    var today = new Date().setHours(0, 0, 0, 0);

    if (httpRequest.url.toLowerCase().indexOf('/planningpme.ics?token=') === 0) {

        var token = url.parse(httpRequest.url, true).query.token.substring(0,32); //max 32 chars
        var mode = url.parse(httpRequest.url, true).query.mode || 'event'; //event (full-day) or appointment

        var decipher = crypto.createDecipher('aes256', cyphersecret);
        try {
            var entityId = parseInt(decipher.update(token, 'hex', 'utf8') + decipher.final('utf8'), 10);
        }
        catch (e) {
            console.warn("Could not decipher " + token);
            httpResponse.writeHead(400, { 'Content-Type': 'text/html' });
            httpResponse.end("Could not decipher your token. Please check format and length.");
            return;
        }
        console.log('Deciphered entityId = ' + entityId);

        getPmeResults(function (err, pmeResults) {
            if (err) {
                httpResponse.writeHead(200, { 'Content-Type': 'text/html' }); //internal server error?
                httpResponse.end("Problem getting PME data from Azure Blob Storage. Please call Intern Support.");
            }
            else {
                ReturnIcalFeed(pmeResults, entityId, mode, httpResponse);
            }
        });
    }
    else if (httpRequest.url.toLowerCase().indexOf('/gettokenfor/') === 0) {
        var name = httpRequest.url.toLowerCase().split('/').slice(-1)[0];
        
        getPmeResults(function (error, pmeResults) {
            var found = false;
            if (!error) {
                var yEntities = pmeResults.value.YEntities;
                for (var i = 0; i < yEntities.length; i++) {
                    var yEntity = yEntities[i];
                    if (yEntity.N.replace(/ /g, "").toLowerCase() === name) {
                        var cipher = crypto.createCipher('aes256', cyphersecret);
                        var encrypted = cipher.update(yEntity.Id.toString(), 'utf8', 'hex') + cipher.final('hex');
                        httpResponse.writeHead(200, { 'Content-Type': 'text/html' });
                        httpResponse.end("Your personal token was generated. Use this url in Outlook as new Internet Calendar Subscription -> webcal://" + httpRequest.headers.host + "/PlanningPME.ics?token=" + encrypted);
                        found = true;
                        break;
                    }
                }
            }
            if (!found) {
                httpResponse.writeHead(200, { 'Content-Type': 'text/html' });
                httpResponse.end("Resource '" + name + "' not found in PlanningPME.");
            }
        });
    }
    else if (httpRequest.url.toLowerCase() === '/gettoken') {
        
            //force https (only in production mode)
    if (!(httpRequest.headers['x-forwarded-proto'] === 'https' || httpRequest.headers['x-arr-ssl'] || process.env.NODE_ENV !== 'production')) {
        httpResponse.writeHead(200, { 'Content-Type': 'text/html' });
        httpResponse.end("Only https requests allowed.");
        return;
    }

        var authHeader = httpRequest.headers.authorization;
        if (!authHeader) {
            return401(httpResponse);
        }

        if (authHeader) {
            var buf = new Buffer(authHeader.split(' ')[1], 'base64');
            var creds = buf.toString().split(':');
            var username = creds[0];
            var password = creds[1];

            var auth = {
                'user': username,
                'pass': password,
                'sendImmediately': true
            };
            refreshPMEData(auth, today, today, sResourceToPlan, function (error, pmeResults) {
                if (error) {
                    if (error == "401") return401(httpResponse);
                    if (error != "401") {
                        httpResponse.writeHead(200, { 'Content-Type': 'text/html' });
                        httpResponse.end("Something went wrong. Error: " + error);
                    }
                    return;
                }

                //console.log('pmeResults=' + pmeResults);
                if (pmeResults.value && pmeResults.value.YEntities && pmeResults.value.YEntities.length === 1) {
                    var cipher = crypto.createCipher('aes256', cyphersecret);
                    var encrypted = cipher.update(pmeResults.value.YEntities[0].Id.toString(), 'utf8', 'hex') + cipher.final('hex');
                    httpResponse.writeHead(200, { 'Content-Type': 'text/html' });
                    httpResponse.end("Your personal token was generated. Use this url in Outlook as new Internet Calendar Subscription -> webcal://" + httpRequest.headers.host + "/PlanningPME.ics?token=" + encrypted);
                }
                else {
                    httpResponse.writeHead(200, { 'Content-Type': 'text/html' });
                    httpResponse.end("Error: could not find a resource in PlanningPME connected to your login. Ask ProjectBureau to add you as default resource in PlanningPME.");
                }
            });
        }
    }
    else if (httpRequest.url.toLowerCase() === '/refresh') {

        var startDate_ms = today - (1000 * 60 * 60 * 24 * lookDaysBack);
        var endDate_ms = today + (1000 * 60 * 60 * 24 * lookDaysAhead);

        refreshPMEData(authPMEUser, startDate_ms, endDate_ms, sResourceHuman, function (error, pmeResults) {
            if (error || !pmeResults) return;

            var pmeResultsString = JSON.stringify(pmeResults);

            zlib.deflate(pmeResultsString, function (err, buffer) {
                if (!err) {
                    var blobService = azure.createBlobService(blobAccount, blobKey);
                    blobService.createBlockBlobFromText('data', 'pme.json.zip.b64', buffer.toString('base64'), function (err, results) { });

                }
            });
        });
        httpResponse.writeHead(200, { 'Content-Type': 'text/html' });
        httpResponse.end("PME data is being refreshed...");
    }
    else {
        httpResponse.writeHead(400, { 'Content-Type': 'text/html' });
        httpResponse.end("Wrong request.");
    }

}).listen(process.env.PORT || 8080);

function getPmeResults(callback) {
    //get from blob storage
    azure.createBlobService(blobAccount, blobKey).getBlobToText('data', 'pme.json.zip.b64', function (err, results) {
        if (err) return callback(err, null);

        //unzip pme data
        var buffer = new Buffer(results, 'base64');
        zlib.unzip(buffer, function (err, buffer) {
            if (err) return callback(err, null);
            var pmeResults = JSON.parse(buffer.toString());
            callback(null, pmeResults);
        });
    });
}

function return401(httpResponse)
{
    // No Authorization header was passed in so it's the first time the browser hit us
    // Sending a 401 will require authentication, we need to send the 'WWW-Authenticate' to tell them the sort of authentication to use
    // Basic auth is quite literally the easiest and least secure, it simply gives back  base64( username + ":" + password ) from the browser
    httpResponse.writeHead(401, { 'WWW-Authenticate': 'Basic realm=""' });
    httpResponse.end('<html><body>Need some creds son</body></html>');
}

function ReturnIcalFeed(pmeResults, entityId, mode, httpResponse) {

    var ical = pme2ical.getICalendarFeed(pmeResults, entityId, mode);
    httpResponse.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    httpResponse.end(ical);
}

function refreshPMEData(auth, startDate_ms, endDate_ms, sResource, callback) {

    console.time("StartSession");
    var j = request.jar(); //new cookie jar for each PME sessions
    request(urlPME, {
        'auth': auth,
        'jar': j
    }, function (error, response, body) {
        console.timeEnd("StartSession");
        if (checkError(error, response, callback)) return;

        //get timezone offset
        console.time("GetTimezoneOffset");
        request.post(urlGetData + "?ts=" + new Date().getTime(), {
            'headers': { "X-AjaxPro-Method": "GetParameter" },
            'json': true,
            'jar': j,
            'body': '{ "dt": "/Date(' + new Date().setHours(0, 0, 0, 0) + ')/" }'
        }, function (error, response, body) {
            console.timeEnd("GetTimezoneOffset");
            if (checkError(error, response, callback)) return;

            var tzo = -body.value.TZO;

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

            console.time("GetDatas");
            request.post(urlGetData, {
                'headers': { "X-AjaxPro-Method": "GetDatas" },
                'json': true,
                'jar': j,
                'body': getDataParams
            }, function (error, response, pmeResults) {
                console.timeEnd("GetDatas");
                if (checkError(error, response, callback)) return;
                console.log('==> pmeResults loaded');

                pmeResults.TZO = tzo;

                callback(null, pmeResults);
            }); //.pipe(fs.createWriteStream('pme.json'));
        });
    });
}

function checkError(error, response, callback) {
    if (error || response.statusCode !== 200) {
        console.log("[ERROR] Request error:" + (error || response.statusCode));
        callback(error || response.statusCode, null);
        return true;
    }
    return false; //no errors
}
