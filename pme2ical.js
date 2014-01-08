var icalendar = require('icalendar');

//Information on icalendar specs:
//  http://en.wikipedia.org/wiki/ICalendar
//  http://www.ietf.org/rfc/rfc2445.txt
//  http://msdn.microsoft.com/en-us/library/gg672059(v=exchg.80).aspx
//  http://www.kanzaki.com/docs/ical/

module.exports = function getICalendarFeed(pmeResults, yEntityId, mode) {
	if (!pmeResults || !yEntityId || !pmeResults.value || !pmeResults.TZO) return;

	var tzOffset = pmeResults.TZO; //timezone offset (Netherlands)
	var task, vEvent, startDateTime, endDateTime, startDateTimeCET, endDateTimeCET, startDateString, subject, eventDuration;

    var ical = new icalendar.iCalendar();
    ical.addProperty("X-PUBLISHED-TTL", "PT30M"); //PT30M = 30 minutes, PT1H = 1 hour
    ical.addProperty("X-WR-CALNAME", "PlanningPME");

    var tasks = pmeResults.value.Tasks;
	for (var i=0; i<tasks.length; i++) {
		task = tasks[i];
		if (task.RI === yEntityId) {
            //get event times
            startDateTime = new Date(parseInt(task.SD.substr(6), 10) + tzOffset);
            endDateTime = new Date(parseInt(task.ED.substr(6), 10) + tzOffset);
            startDateString = startDateTime.getUTCFullYear() + ('0' + (startDateTime.getUTCMonth()+1)).slice(-2) + ('0' + startDateTime.getUTCDate()).slice(-2);
            
            //set id
            vEvent = new icalendar.VEvent('PME-' + task.Id + '-' + startDateString); //add start-date because task's Id isn't always unique
            
            //set start en end datetime
            if (mode === 'appointment') {
                vEvent.setDate(startDateTime, endDateTime);
            }
            else {
                //mode event -> full day events
                vEvent_setFullDay(vEvent, startDateTime);
            }

            //set subject
            subject = task.D;
            if (mode === 'event') {
                eventDuration = dateDiffInHours(startDateTime, endDateTime);
                if (eventDuration < 8) {
                startDateTimeCET = new Date(startDateTime.getTime() - tzOffset);
                endDateTimeCET = new Date(endDateTime.getTime() - tzOffset);
                subject = "[" + ('0' + startDateTimeCET.getUTCHours()).slice(-2) + ":" + ('0' + startDateTimeCET.getUTCMinutes()).slice(-2) +
                    "-" + ('0' + endDateTimeCET.getUTCHours()).slice(-2) + ":" + ('0' + endDateTimeCET.getUTCMinutes()).slice(-2) + "] " + subject;
                }
            }
            vEvent.setSummary(subject);

            //set description
            if (task.R) vEvent.setDescription(task.R.replace(/\r/g,""));

            if (mode === 'appointment') {
                if ([7].indexOf(task.S) != -1) vEvent.addProperty("X-MICROSOFT-CDO-BUSYSTATUS", "FREE");
                if ([3,4].indexOf(task.S) != -1) vEvent.addProperty("X-MICROSOFT-CDO-BUSYSTATUS", "TENTATIVE");
                if ([0].indexOf(task.S) != -1) vEvent.addProperty("X-MICROSOFT-CDO-BUSYSTATUS", "BUSY");
                if ([1,2,5,6,8].indexOf(task.S) != -1) vEvent.addProperty("X-MICROSOFT-CDO-BUSYSTATUS", "OOF");   
            }
            else {
                //fullday events are not visible in availibity searches
                vEvent.addProperty("TRANSP", "TRANSPARENT"); //BUSYSTATUS = FREE 
            }

            ical.addComponent(vEvent);
		}
	}
	return ical.toString();
}

//calculate timespan in hours between two dates
function dateDiffInHours(date1, date2) {
  return Math.floor(Math.abs(date1.getTime() - date2.getTime()) / (1000 * 60 * 30)) / 2;
}

function vEvent_setFullDay(vEvent, fullDay) {
    vEvent.addProperty('DTSTART;VALUE=DATE', fullDay.getUTCFullYear() + ('0' + (fullDay.getUTCMonth()+1)).slice(-2) + ('0' + fullDay.getUTCDate()).slice(-2));
    var eod = new Date(fullDay.getFullYear(), fullDay.getMonth(), fullDay.getDate()+1);
    vEvent.addProperty('DTEND;VALUE=DATE', eod.getUTCFullYear() + ('0' + (eod.getUTCMonth()+1)).slice(-2) + ('0' + eod.getUTCDate()).slice(-2));
}
