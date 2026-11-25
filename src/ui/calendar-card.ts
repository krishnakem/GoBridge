/**
 * Calendar card (ui://gobridge/calendar.html): list_events as a day timeline,
 * plus the other calendar views added in later phases.
 *
 * Event titles, places and descriptions are shown as plain text. Positions on
 * the timeline are numbers worked out from the event times, never text from
 * an event. The one link is "Open in Calendar", through the host's
 * ui/open-link and only for https://calendar.google.com.
 */

export const CALENDAR_CSS = String.raw`
.day-nav { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px; }
.allday { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 8px; }
.timeline { position: relative; height: 400px; margin: 4px 16px 12px 64px; border-top: 1px solid var(--line); }
.hour { position: absolute; left: -56px; right: 0; border-top: 1px solid var(--line); height: 0; }
.hour-label { position: absolute; top: -9px; left: 0; width: 50px; text-align: right; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.ev {
	all: unset;
	box-sizing: border-box;
	position: absolute;
	overflow: hidden;
	border-radius: 8px;
	padding: 3px 8px;
	font-size: 12px;
	font-weight: 600;
	border: 1px solid var(--bg);
	cursor: pointer;
}
.ev:disabled { cursor: default; }
.ev-time { font-weight: 400; }
.ev-conflict { border: 2px solid var(--warn-fg); }
.ev-pill { position: static; display: inline-block; }
.outside { display: flex; flex-direction: column; }
`;

export const CALENDAR_JS = String.raw`
(function () {
	var CALENDAR_HOSTS = ["calendar.google.com"];
	var DAY_START = 9 * 60;
	var DAY_END = 17 * 60;

	/** "2026-10-05T09:30:00-04:00" -> { date: "2026-10-05", minutes: 570 }; a bare date has minutes null. */
	function parts(value) {
		var match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(value || ""));
		if (!match) return null;
		return { date: match[1] + "-" + match[2] + "-" + match[3], minutes: match[4] === undefined ? null : Number(match[4]) * 60 + Number(match[5]) };
	}
	function shiftDay(date, days) {
		var bits = date.split("-");
		return new Date(Date.UTC(Number(bits[0]), Number(bits[1]) - 1, Number(bits[2]) + days)).toISOString().slice(0, 10);
	}
	function today() {
		var now = new Date();
		return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);
	}
	function dayLabel(date) {
		var time = Date.parse(date + "T12:00:00Z");
		if (isNaN(time)) return date;
		return new Date(time).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
	}
	function timeLabel(minutes) {
		var hour = Math.floor(minutes / 60);
		var minute = minutes % 60;
		return ((hour + 11) % 12) + 1 + (minute ? ":" + (minute < 10 ? "0" : "") + minute : "") + (hour < 12 ? " AM" : " PM");
	}
	function range(event) {
		var start = parts(event.start);
		var end = parts(event.end);
		if (!start || start.minutes === null) return "All day";
		return timeLabel(start.minutes) + (end && end.minutes !== null ? " to " + timeLabel(end.minutes) : "");
	}
	/** Google's own event link, rebuilt on calendar.google.com. "" for anything else. */
	function calendarLink(htmlLink) {
		try {
			var url = new URL(String(htmlLink));
			var eid = url.searchParams.get("eid") || "";
			var google = url.protocol === "https:" && (url.hostname === "www.google.com" || url.hostname === "calendar.google.com");
			if (!google || !/^[A-Za-z0-9_-]{1,400}$/.test(eid)) return "";
			return "https://calendar.google.com/calendar/event?eid=" + eid;
		} catch (e) {
			return "";
		}
	}

	App.view("list_events", function (parsed, args, account) {
		var zone = typeof args.timeZone === "string" ? args.timeZone : "";
		var state = { day: "", entries: [], others: null, notice: "", spans: 0 };
		function add(data, alias) {
			(Array.isArray(data.events) ? data.events : []).forEach(function (event) {
				state.entries.push({ event: event, account: alias });
			});
		}
		add(parsed.data, account);
		var asked = parts(args.startTime);
		var first = state.entries.length ? parts(state.entries[0].event.start) : null;
		state.day = (asked && asked.date) || (first && first.date) || today();
		var days = {};
		state.entries.forEach(function (entry) {
			var start = parts(entry.event.start);
			if (start) days[start.date] = 1;
		});
		state.spans = Object.keys(days).length;

		function dayArgs(alias) {
			var out = { account: alias, startTime: state.day + "T00:00:00", endTime: shiftDay(state.day, 1) + "T00:00:00" };
			if (typeof args.calendarId === "string" && alias === account) out.calendarId = args.calendarId;
			if (zone) out.timeZone = zone;
			return out;
		}
		/** Loads the shown day for every account on the card. Only on the user's click. */
		function load(aliases) {
			var queue = aliases.slice();
			var failed = 0;
			state.entries = [];
			state.notice = "Loading…";
			state.spans = 1;
			App.redraw();
			function next() {
				var alias = queue.shift();
				if (!alias) {
					state.notice = failed ? plural(failed, "account") + " could not be loaded." : "";
					return App.redraw();
				}
				App.call("list_events", dayArgs(alias)).then(function (result) {
					if (result.data) add(result.data, alias);
					else failed++;
					next();
				});
			}
			next();
		}
		function shown() {
			return [account].concat(state.others || []);
		}
		function move(days) {
			state.day = shiftDay(state.day, days);
			load(shown());
		}
		function showOthers() {
			state.notice = "Checking the other accounts…";
			App.redraw();
			App.call("list_accounts", {}).then(function (result) {
				if (result.error) {
					state.notice = result.error;
					return App.redraw();
				}
				state.others = (Array.isArray(result.data.accounts) ? result.data.accounts : [])
					.map(function (entry) {
						return entry && entry.alias;
					})
					.filter(function (alias) {
						return typeof alias === "string" && alias !== account;
					});
				load(shown());
			});
		}
		function openEvent(entry) {
			if (!App.has("get_event") || !entry.account || typeof entry.event.eventId !== "string") return;
			var call = { account: entry.account, eventId: entry.event.eventId };
			if (typeof args.calendarId === "string" && entry.account === account) call.calendarId = args.calendarId;
			if (zone) call.timeZone = zone;
			App.open("get_event", call);
		}

		App.go(function () {
			var timed = [];
			var allDay = [];
			var outside = [];
			state.entries.forEach(function (entry) {
				var start = parts(entry.event.start);
				var end = parts(entry.event.end);
				if (!start) return;
				// A multi-day all-day event covers the day when it starts before and ends after it.
				var covers = start.minutes === null && end && start.date < state.day && end.date > state.day;
				if (start.date !== state.day && !covers) return;
				if (start.minutes === null) return allDay.push(entry);
				var finish = end && end.minutes !== null && end.date === start.date ? end.minutes : 24 * 60;
				var slot = { entry: entry, start: start.minutes, end: Math.max(finish, start.minutes + 15), lane: 0, conflict: false };
				if (slot.end <= DAY_START || slot.start >= DAY_END) outside.push(slot);
				else timed.push(slot);
			});
			timed.sort(function (a, b) {
				return a.start - b.start || a.end - b.end;
			});
			var laneEnds = [];
			timed.forEach(function (slot) {
				var lane = 0;
				while (lane < laneEnds.length && laneEnds[lane] > slot.start) lane++;
				laneEnds[lane] = slot.end;
				slot.lane = lane;
				timed.forEach(function (other) {
					if (other !== slot && other.start < slot.end && slot.start < other.end) slot.conflict = other.conflict = true;
				});
			});
			var lanes = Math.max(1, laneEnds.length);

			var nav = el(
				"div",
				"day-nav",
				null,
				iconButton("left", "Previous day", function () {
					move(-1);
				}),
				el("div", "stack", null, el("div", "title", dayLabel(state.day)), el("div", "muted", zone ? "Times in " + zone : "")),
				iconButton("right", "Next day", function () {
					move(1);
				})
			);
			var strip = el("div", "allday");
			allDay.forEach(function (entry) {
				strip.appendChild(el("span", "ev ev-pill " + accountClass(entry.account), entry.event.summary || "All-day event"));
			});
			var timeline = el("div", "timeline");
			for (var hour = DAY_START; hour <= DAY_END; hour += 60) {
				var mark = el("div", "hour", null, el("span", "hour-label", timeLabel(hour)));
				mark.style.setProperty("top", ((hour - DAY_START) / (DAY_END - DAY_START)) * 100 + "%");
				timeline.appendChild(mark);
			}
			var conflicts = 0;
			timed.forEach(function (slot) {
				var from = Math.max(slot.start, DAY_START);
				var to = Math.min(slot.end, DAY_END);
				var block = button("", "ev " + accountClass(slot.entry.account) + (slot.conflict ? " ev-conflict" : ""), function () {
					openEvent(slot.entry);
				});
				block.appendChild(el("div", "clip", slot.entry.event.summary || "Busy"));
				block.appendChild(el("div", "ev-time clip", range(slot.entry.event) + (slot.conflict ? " · Overlaps" : "")));
				block.style.setProperty("top", ((from - DAY_START) / (DAY_END - DAY_START)) * 100 + "%");
				block.style.setProperty("height", Math.max(((to - from) / (DAY_END - DAY_START)) * 100, 6) + "%");
				block.style.setProperty("left", (slot.lane / lanes) * 100 + "%");
				block.style.setProperty("width", 100 / lanes + "%");
				if (!App.has("get_event")) block.disabled = true;
				if (slot.conflict) conflicts++;
				timeline.appendChild(block);
			});
			var later = el("div", "outside");
			outside.forEach(function (slot) {
				later.appendChild(
					el("div", "line", null, el("span", "muted", range(slot.entry.event)), el("span", "grow clip", slot.entry.event.summary || "Busy"), accountChip(slot.entry.account))
				);
			});
			var notes = [];
			if (state.notice) notes.push(state.notice);
			else {
				if (!timed.length && !allDay.length && !outside.length) notes.push("Nothing on this day.");
				if (conflicts) notes.push(plural(conflicts, "event") + " overlap.");
				if (outside.length) notes.push(plural(outside.length, "event") + " outside 9 AM to 5 PM, listed below the timeline.");
				if (state.spans > 1) notes.push("This result covers " + state.spans + " days; one day is shown at a time.");
			}
			var legend = el("div", "wrap pad");
			shown().forEach(function (alias) {
				legend.appendChild(accountChip(alias));
			});
			App.draw({
				tool: "list_events",
				account: state.others && state.others.length ? "" : account,
				line: App.argsLine(args),
				body: [nav, allDay.length ? strip : null, timeline, outside.length ? later : null, state.others && state.others.length ? legend : null],
				actions: [account && !state.others ? button("Show other accounts", "btn", showOthers) : null],
				note: notes.join(" ") + " Event text renders as plain text.",
			});
		});
	});

	App.start("GoBridge calendar", function (data) {
		if (Array.isArray(data.events)) return "list_events";
		return "";
	});
})();
`;
