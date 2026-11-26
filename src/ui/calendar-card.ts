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
.day-nav { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 8px 12px; }
.day-nav .btn-icon { border-color: transparent; }
.day-nav .stack { align-items: center; text-align: center; }
.allday { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 12px 6px; }
.timeline { position: relative; height: 264px; margin: 6px 12px 10px 52px; border-top: 1px solid var(--line); }
.hour { position: absolute; left: -46px; right: 0; border-top: 1px solid var(--line); height: 0; }
.hour-label { position: absolute; top: -7px; left: 0; width: 40px; text-align: right; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.ev {
	all: unset;
	box-sizing: border-box;
	position: absolute;
	overflow: hidden;
	border-radius: 6px;
	padding: 2px 6px;
	font-size: 11px;
	font-weight: 600;
	line-height: 1.3;
	color: var(--fg);
	background: var(--bg-hover);
	border: 1px solid var(--bg);
	cursor: pointer;
}
.ev:hover { background: var(--line); }
.ev:disabled { cursor: default; }
.ev-time { font-weight: 400; color: var(--muted); }
.ev-conflict { box-shadow: inset 0 0 0 1px var(--fg); }
.ev-pill { position: static; display: inline-block; max-width: 100%; white-space: nowrap; text-overflow: ellipsis; }
.outside { display: flex; flex-direction: column; }
.invite-clash { background: var(--bg-soft); }
.line { flex-wrap: wrap; }
.line .btn { min-height: 26px; }
.guest { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 12px; border-bottom: 1px solid var(--line); font-size: 12px; }
.guest:last-of-type { border-bottom: 0; }
.group { padding: 8px 12px 2px; font-size: 11px; font-weight: 600; color: var(--muted); }
.event-row { flex-direction: row; align-items: center; gap: 10px; }
.date-block { flex: none; width: 36px; text-align: center; border: 1px solid var(--line); border-radius: 8px; padding: 1px 0; background: var(--bg); }
.date-month { font-size: 9px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.date-day { font-size: 14px; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; }
.slot-days { display: flex; gap: 10px; padding: 10px 12px; overflow-x: auto; }
.slot-day { display: flex; flex-direction: column; gap: 4px; min-width: 120px; }
.slot { justify-content: flex-start; font-variant-numeric: tabular-nums; }
.slot-best { border-color: var(--fg); }
.slot-on, .slot-on:hover { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.legend { display: flex; flex-wrap: wrap; gap: 10px; padding: 0 12px 10px; font-size: 11px; color: var(--muted); }
.key { display: inline-block; width: 10px; height: 10px; border-radius: 3px; border: 1px solid var(--line); vertical-align: -1px; margin-right: 4px; }
.key-best { border-color: var(--fg); }
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
		var state = { day: "", entries: [], others: null, notice: "", spans: 0, replied: {} };
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
				block.style.setProperty("height", Math.max(((to - from) / (DAY_END - DAY_START)) * 100, 8) + "%");
				block.style.setProperty("left", (slot.lane / lanes) * 100 + "%");
				block.style.setProperty("width", 100 / lanes + "%");
				if (!App.has("get_event")) block.disabled = true;
				if (slot.conflict) conflicts++;
				timeline.appendChild(block);
			});
			var later = el("div", "outside");
			outside.forEach(function (slot) {
				later.appendChild(
					el("div", "line", null, el("span", "muted nowrap", range(slot.entry.event)), el("span", "grow clip", slot.entry.event.summary || "Busy"), state.others && state.others.length ? accountChip(slot.entry.account) : null)
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
			// Invitations on this day that still wait for this account's reply.
			var invites = [];
			if (WRITES) {
				state.entries.forEach(function (entry) {
					var start = parts(entry.event.start);
					if (!start || start.date !== state.day || !entry.account || !isId(entry.event.eventId)) return;
					var mine = (Array.isArray(entry.event.attendees) ? entry.event.attendees : []).filter(function (guest) {
						return guest.self === true;
					})[0];
					var replied = state.replied[entry.account + "/" + entry.event.eventId];
					if (!replied && !(mine && mine.responseStatus === "needsAction")) return;
					var clash = timed.some(function (slot) {
						return slot.entry === entry && slot.conflict;
					});
					var row = el("div", "line", null, el("span", "stack grow", null, el("span", "strong clip", entry.event.summary || "Untitled event"), el("span", "muted clip", range(entry.event) + (clash ? " · Overlaps another event" : ""))), accountChip(entry.account));
					var eventArgs = entry.account === account && typeof args.calendarId === "string" ? { calendarId: args.calendarId } : {};
					var answer = function (status, word) {
						respond(entry.event, eventArgs, entry.account, status, word, "", function () {
							if (status === "needsAction") delete state.replied[entry.account + "/" + entry.event.eventId];
							else state.replied[entry.account + "/" + entry.event.eventId] = word;
							App.redraw();
						});
					};
					if (replied) {
						row.appendChild(el("span", "tag", "You replied " + replied));
						row.appendChild(
							button("Undo", "btn", function () {
								answer("needsAction", "Undo");
							})
						);
					} else {
						[["accepted", "Yes"], ["tentative", "Maybe"], ["declined", "No"]].forEach(function (choice) {
							row.appendChild(
								button(choice[1], "btn", function () {
									answer(choice[0], choice[1]);
								})
							);
						});
					}
					if (clash) row.className = "line invite-clash";
					invites.push(row);
				});
			}
			var inviteBlock = invites.length ? el.apply(null, ["div", "outside", null, el("div", "group", "Invitations waiting for your reply")].concat(invites)) : null;
			var legend = el("div", "wrap pad");
			shown().forEach(function (alias) {
				legend.appendChild(accountChip(alias));
			});
			App.draw({
				tool: "list_events",
				account: state.others && state.others.length ? "" : account,
				line: App.argsLine(args),
				body: [nav, allDay.length ? strip : null, timeline, outside.length ? later : null, inviteBlock, state.others && state.others.length ? legend : null],
				actions: [
					WRITES && account
						? button("New event", "btn", function () {
								createScreen({ day: state.day, zone: zone }, account);
							})
						: null,
					account
						? button("Find free time", "btn", function () {
								findTimeScreen(state.day, zone, account);
							})
						: null,
					account && !state.others ? button("Show other accounts", "btn", showOthers) : null,
				],
				note: notes.join(" ") + " Event text renders as plain text.",
			});
		});
	});

	var RSVP = { accepted: ["Yes", "tag"], declined: ["No", "tag"], tentative: ["Maybe", "tag"], needsAction: ["No reply", "tag"] };
	function rsvpTag(status) {
		var known = Object.prototype.hasOwnProperty.call(RSVP, status) ? RSVP[status] : ["Unknown", "tag"];
		return el("span", known[1], known[0]);
	}
	function whenLine(event) {
		var start = parts(event.start);
		return (start ? dayLabel(start.date) + ", " : "") + range(event) + (event.timeZone ? " (" + event.timeZone + ")" : "");
	}

	/** One event in full. Also the receipt for the calendar write tools. */
	function eventScreen(tool, event, args, account, banner, undoTo) {
		App.go(function () {
			var guests = Array.isArray(event.attendees) ? event.attendees : [];
			// At most five rows: title, when, where, and two lines of description.
			var top = el(
				"div",
				"pad stack",
				null,
				el("div", "row", null, el("span", "title clip", event.summary || "Untitled event"), event.status === "cancelled" ? el("span", "tag", "Cancelled") : null),
				el("div", "clip", whenLine(event))
			);
			if (event.location) top.appendChild(el("div", "muted clip", event.location));
			if (event.description) top.appendChild(el("div", "muted", null, moreText(event.description, 2)));
			var body = [banner ? el("div", "banner banner-ok", banner) : null, top];
			if (guests.length) {
				body.push(el("div", "group", plural(guests.length, "guest")));
				guests.forEach(function (guest) {
					body.push(
						el(
							"div",
							"guest",
							null,
							el("span", "grow clip", (guest.displayName ? guest.displayName + " · " : "") + (guest.email || "Guest") + (guest.self ? " (you)" : "")),
							guest.optional ? el("span", "tag", "Optional") : null,
							rsvpTag(guest.responseStatus)
						)
					);
				});
				if (Number(event.attendeesOmitted) > 0) body.push(el("div", "footnote", plural(Number(event.attendeesOmitted), "more guest") + " not shown."));
			}
			var canWrite = WRITES && account && isId(event.eventId) && event.status !== "cancelled";
			var mine = guests.filter(function (guest) {
				return guest.self === true;
			})[0];
			var actions = [];
			if (canWrite && mine) {
				[["accepted", "Yes"], ["tentative", "Maybe"], ["declined", "No"]].forEach(function (choice) {
					if (mine.responseStatus === choice[0]) return;
					actions.push(
						button("Reply " + choice[1], "btn", function () {
							respond(event, args, account, choice[0], choice[1], mine.responseStatus);
						})
					);
				});
			}
			if (canWrite && undoTo) {
				actions.push(
					button("Undo", "btn", function () {
						respond(event, args, account, undoTo, "Undo", "");
					})
				);
			}
			if (canWrite) {
				actions.push(
					button("Edit", "btn", function () {
						editScreen(event, args, account);
					})
				);
				actions.push(
					button("Add guests", "btn", function () {
						guestsScreen(event, args, account);
					})
				);
				actions.push(
					button("Delete", "btn", function () {
						App.confirm({
							account: account,
							action: "Delete this event",
							target: clip(event.summary || "Untitled event", 80) + " · " + whenLine(event),
							label: "Delete event",
							twoClick: true,
							danger: true,
							usage: "write",
							note: "No cancellation emails are sent to guests.",
							run: function () {
								return App.call("delete_event", eventCall(event, args, account, { notificationLevel: "NONE" }));
							},
							done: function () {
								App.replaceMessage("delete_event", account, "Event deleted. No emails were sent.");
							},
						});
					})
				);
			}
			actions.push(linkButton("Open in Calendar", calendarLink(event.htmlLink), CALENDAR_HOSTS, "btn btn-primary"));
			App.draw({
				tool: tool,
				account: account,
				line: App.argsLine(args),
				body: body,
				actions: actions,
				note: "Event text renders as plain text.",
			});
		});
	}

	function isId(value) {
		return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
	}
	/** account + eventId (+ the calendar and time zone the card was opened with) + extra fields. */
	function eventCall(event, args, account, extra) {
		var call = { account: account, eventId: event.eventId };
		if (typeof args.calendarId === "string") call.calendarId = args.calendarId;
		Object.keys(extra || {}).forEach(function (key) {
			call[key] = extra[key];
		});
		return call;
	}
	var REPLY_WORDS = { accepted: "Yes", tentative: "Maybe", declined: "No", needsAction: "No reply" };
	/** Sets this account's own RSVP after a confirm, then shows the event again with Undo. */
	function respond(event, args, account, status, word, previous, after) {
		App.confirm({
			account: account,
			action: status === "needsAction" ? "Clear my reply to this invitation" : "Reply " + (REPLY_WORDS[status] || word) + " to this invitation",
			target: clip(event.summary || "Untitled event", 80) + " · " + whenLine(event),
			label: status === "needsAction" ? "Clear reply" : "Reply " + (REPLY_WORDS[status] || word),
			usage: "write",
			note: "No email is sent to the organiser.",
			run: function () {
				return App.call("respond_to_event", eventCall(event, args, account, { responseStatus: status, notificationLevel: "NONE" }));
			},
			done: function (updated) {
				if (after) return after(updated);
				App.replace("respond_to_event", { data: updated }, { account: account, calendarId: args.calendarId, previous: previous });
			},
		});
	}

	var NOTIFY_OPTIONS = [["NONE", "Don't email guests"], ["ALL", "Email everyone"], ["EXTERNAL_ONLY", "Email outside guests only"]];
	var NOTIFY_WORDS = { NONE: "no emails are sent", ALL: "EVERY guest is emailed", EXTERNAL_ONLY: "guests outside your organisation are emailed" };
	function notifyControl() {
		return select(NOTIFY_OPTIONS, "NONE");
	}
	function clock(minutes) {
		var hour = Math.floor(minutes / 60);
		var minute = minutes % 60;
		return (hour < 10 ? "0" : "") + hour + ":" + (minute < 10 ? "0" : "") + minute;
	}
	function validDay(value) {
		return /^\d{4}-\d{2}-\d{2}$/.test(value);
	}
	function validClock(value) {
		return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
	}

	/** The new-event form. Opened from a suggested slot or from the day view. */
	function createScreen(prefill, account) {
		var title = input("text", prefill.title || "");
		var day = input("date", prefill.day || "");
		var start = input("time", prefill.start || "09:00");
		var end = input("time", prefill.end || "09:30");
		var guests = input("text", (prefill.guests || []).join(", "));
		var notify = notifyControl();
		var calendars = [{ id: "primary", name: "Primary calendar" }];
		var picker = el("div", "stack");
		var chosen = 0;
		var status = el("div", "muted");
		function drawPicker() {
			// Option values are positions in the list, never text from Google.
			var options = document.createElement("select");
			options.className = "input";
			calendars.forEach(function (calendar, index) {
				var option = document.createElement("option");
				option.value = String(index);
				option.textContent = calendar.name;
				options.appendChild(option);
			});
			options.value = String(chosen);
			options.addEventListener("change", function () {
				chosen = Number(options.value) || 0;
			});
			var load =
				calendars.length === 1
					? button("Load my calendars", "btn", function () {
							App.call("list_calendars", { account: account }).then(function (result) {
								if (result.error) {
									status.textContent = result.error;
									return;
								}
								(Array.isArray(result.data.calendars) ? result.data.calendars : []).forEach(function (calendar) {
									var writable = calendar.accessRole === "owner" || calendar.accessRole === "writer";
									if (!calendar.primary && writable && typeof calendar.calendarId === "string") calendars.push({ id: calendar.calendarId, name: calendar.summary || "Calendar" });
								});
								if (calendars.length === 1) status.textContent = "No other calendar you can add events to.";
								drawPicker();
							});
						})
					: null;
			picker.replaceChildren.apply(picker, [field("Calendar", options), load].filter(Boolean));
		}
		drawPicker();
		App.go(function () {
			App.draw({
				tool: "create_event",
				account: account,
				line: "",
				body: [
					el("div", "form", null, field("Title", title), field("Date", day), field("Starts", start), field("Ends", end), picker, field("Guests (email addresses)", guests), field("Email guests", notify), status),
				],
				actions: [
					button("Create event", "btn btn-primary", function () {
						var name = title.value.trim();
						if (!name || !validDay(day.value) || !validClock(start.value) || !validClock(end.value)) {
							status.textContent = "Give a title, a date, and start and end times.";
							return;
						}
						if (end.value <= start.value) {
							status.textContent = "The end time must be after the start time.";
							return;
						}
						status.textContent = "";
						var emails = emailsIn(guests.value);
						var level = notify.value;
						var call = { account: account, summary: name, startTime: day.value + "T" + start.value + ":00", endTime: day.value + "T" + end.value + ":00", notificationLevel: level };
						if (prefill.zone) call.timeZone = prefill.zone;
						if (calendars[chosen] && calendars[chosen].id !== "primary") call.calendarId = calendars[chosen].id;
						if (emails.length) {
							call.attendees = emails.map(function (address) {
								return { email: address };
							});
						}
						App.confirm({
							account: account,
							action: "Create an event: " + (emails.length ? NOTIFY_WORDS[level] || NOTIFY_WORDS.NONE : "no guests"),
							target: clip(name, 80) + " · " + dayLabel(day.value) + ", " + timeLabel(parts(day.value + "T" + start.value).minutes) + " to " + timeLabel(parts(day.value + "T" + end.value).minutes) + (emails.length ? " · " + emails.join(", ") : ""),
							label: level === "NONE" || !emails.length ? "Create event" : "Create and email guests",
							twoClick: level !== "NONE" && emails.length > 0,
							usage: "write",
							note: level === "ALL" ? "Everyone emails every guest on the list." : level === "EXTERNAL_ONLY" ? "Guests outside your organisation get an invitation email." : "No invitation emails are sent.",
							run: function () {
								return App.call("create_event", call);
							},
							done: function (created) {
								App.replace("create_event", { data: created }, { account: account, calendarId: call.calendarId, timeZone: call.timeZone });
							},
						});
					}),
				],
				note: "Everyone emails every guest. The default sends no emails. Nothing is created until you confirm.",
			});
		});
	}

	function editScreen(event, args, account) {
		var from = parts(event.start);
		var until = parts(event.end);
		var timed = from && from.minutes !== null && until && until.minutes !== null;
		var title = input("text", event.summary || "");
		var place = input("text", event.location || "");
		var day = input("date", from ? from.date : "");
		var start = input("time", timed ? clock(from.minutes) : "");
		var end = input("time", timed ? clock(until.minutes) : "");
		var status = el("div", "muted");
		App.go(function () {
			App.draw({
				tool: "update_event",
				account: account,
				line: "",
				body: [
					el("div", "form", null, field("Title", title), field("Place", place), timed ? field("Date", day) : null, timed ? field("Starts", start) : null, timed ? field("Ends", end) : null, timed ? null : el("div", "muted", "This is an all-day event; its dates are not changed here."), status),
				],
				actions: [
					button("Save changes", "btn btn-primary", function () {
						var changed = {};
						var name = title.value.trim();
						if (name && name !== (event.summary || "")) changed.summary = name;
						if (place.value !== (event.location || "")) changed.location = place.value;
						if (timed && (day.value !== from.date || start.value !== clock(from.minutes) || end.value !== clock(until.minutes))) {
							if (!validDay(day.value) || !validClock(start.value) || !validClock(end.value) || end.value <= start.value) {
								status.textContent = "Give a date, and an end time after the start time.";
								return;
							}
							changed.startTime = day.value + "T" + start.value + ":00";
							changed.endTime = day.value + "T" + end.value + ":00";
						}
						if (!Object.keys(changed).length) {
							status.textContent = "Nothing has changed.";
							return;
						}
						status.textContent = "";
						changed.notificationLevel = "NONE";
						if (typeof event.timeZone === "string" && event.timeZone) changed.timeZone = event.timeZone;
						App.confirm({
							account: account,
							action: "Change this event (no emails are sent)",
							target: clip(event.summary || "Untitled event", 80) + " · " + whenLine(event),
							label: "Save changes",
							usage: "write",
							run: function () {
								return App.call("update_event", eventCall(event, args, account, changed));
							},
							done: function (updated) {
								App.replace("update_event", { data: updated }, { account: account, calendarId: args.calendarId });
							},
						});
					}),
				],
				note: "No emails are sent to guests. Nothing changes until you confirm.",
			});
		});
	}

	function guestsScreen(event, args, account) {
		var guests = input("text", "");
		var notify = notifyControl();
		var status = el("div", "muted");
		App.go(function () {
			App.draw({
				tool: "update_event",
				account: account,
				line: "",
				body: [el("div", "form", null, field("Guests to add (email addresses)", guests), field("Email guests", notify), status)],
				actions: [
					button("Add guests", "btn btn-primary", function () {
						var emails = emailsIn(guests.value);
						if (!emails.length) {
							status.textContent = "Enter at least one email address.";
							return;
						}
						status.textContent = "";
						var level = notify.value;
						App.confirm({
							account: account,
							action: "Add guests to this event: " + (NOTIFY_WORDS[level] || NOTIFY_WORDS.NONE),
							target: clip(event.summary || "Untitled event", 80) + " · " + emails.join(", "),
							label: level === "NONE" ? "Add guests" : "Add and email guests",
							twoClick: level !== "NONE",
							usage: "write",
							note: level === "ALL" ? "Everyone emails every guest on the event, not only the new ones." : level === "EXTERNAL_ONLY" ? "Guests outside your organisation get an email." : "No emails are sent.",
							run: function () {
								return App.call(
									"update_event",
									eventCall(event, args, account, {
										addedAttendees: emails.map(function (address) {
											return { email: address };
										}),
										notificationLevel: level,
									})
								);
							},
							done: function (updated) {
								App.replace("update_event", { data: updated }, { account: account, calendarId: args.calendarId });
							},
						});
					}),
				],
				note: "Everyone emails every guest. The default sends no emails.",
			});
		});
	}

	App.view("get_event", function (parsed, args, account) {
		eventScreen("get_event", parsed.data, args, account, "", "");
	});
	App.view("create_event", function (parsed, args, account) {
		eventScreen("create_event", parsed.data, args, account, parsed.data.attendeesEmailed ? "Event created. Guests were emailed." : "Event created. No invitation emails were sent.", "");
	});
	App.view("update_event", function (parsed, args, account) {
		eventScreen("update_event", parsed.data, args, account, parsed.data.attendeesEmailed ? "Event changed. Guests were emailed." : "Event changed. No emails were sent.", "");
	});
	App.view("respond_to_event", function (parsed, args, account) {
		var reply = REPLY_WORDS[parsed.data.response] || "saved";
		// Undo goes back to the reply the card replaced; a reply the model set can be cleared.
		var before = typeof args.previous === "string" && Object.prototype.hasOwnProperty.call(REPLY_WORDS, args.previous) ? args.previous : "needsAction";
		eventScreen("respond_to_event", parsed.data, { calendarId: args.calendarId }, account, "Your reply: " + reply + ". No email was sent.", parsed.data.response === before ? "" : before);
	});

	App.view("search_events", function (parsed, args, account) {
		var state = { events: Array.isArray(parsed.data.events) ? parsed.data.events.slice() : [], next: parsed.data.nextPageToken || "", notice: "" };
		function loadMore() {
			var more = {};
			Object.keys(args).forEach(function (key) {
				more[key] = args[key];
			});
			more.pageToken = state.next;
			state.notice = "Loading more…";
			App.redraw();
			App.call("search_events", more).then(function (result) {
				state.notice = result.error || "";
				if (result.data) {
					state.events = state.events.concat(Array.isArray(result.data.events) ? result.data.events : []);
					state.next = result.data.nextPageToken || "";
				}
				App.redraw();
			});
		}
		App.go(function () {
			// Weeks start on Monday, counted from today on the viewer's own clock.
			var now = today();
			var weekday = (new Date(Date.parse(now + "T12:00:00Z")).getUTCDay() + 6) % 7;
			var thisWeek = shiftDay(now, -weekday);
			var nextWeek = shiftDay(thisWeek, 7);
			var later = shiftDay(thisWeek, 14);
			var groups = [["Earlier", []], ["This week", []], ["Next week", []], ["Later", []]];
			state.events.forEach(function (event) {
				var start = parts(event.start);
				var date = start ? start.date : "";
				var index = !date || date < thisWeek ? 0 : date < nextWeek ? 1 : date < later ? 2 : 3;
				groups[index][1].push(event);
			});
			var body = [];
			groups.forEach(function (group) {
				if (!group[1].length) return;
				body.push(el("div", "group", group[0]));
				group[1].forEach(function (event) {
					var start = parts(event.start);
					var time = start ? Date.parse(start.date + "T12:00:00Z") : NaN;
					var block = el(
						"span",
						"date-block",
						null,
						el("div", "date-month", isNaN(time) ? "" : new Date(time).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" })),
						el("div", "date-day", isNaN(time) ? "?" : String(new Date(time).getUTCDate()))
					);
					var row = button("", "item event-row", function () {
						if (!account || typeof event.eventId !== "string") return;
						var call = { account: account, eventId: event.eventId };
						if (typeof args.timeZone === "string") call.timeZone = args.timeZone;
						App.open("get_event", call);
					});
					row.appendChild(block);
					row.appendChild(
						el("span", "stack grow", null, el("span", "strong clip", event.summary || "Untitled event"), el("span", "muted clip", [range(event), event.location].filter(Boolean).join(" · ")))
					);
					if (!account) row.disabled = true;
					body.push(row);
				});
			});
			if (!state.events.length) body.push(el("p", "note", "No events found."));
			App.draw({
				tool: "search_events",
				account: account,
				line: App.argsLine(args),
				body: body,
				actions: [state.next ? button("Load more", "btn", loadMore) : null],
				note: (state.notice ? state.notice + " " : "") + "Event text renders as plain text.",
			});
		});
	});

	App.view("suggest_time", function (parsed, args, account) {
		var data = parsed.data;
		var slots = (Array.isArray(data.suggestions) ? data.suggestions : []).filter(function (slot) {
			var start = parts(slot && slot.start);
			return start && start.minutes !== null;
		});
		var state = { chosen: -1 };
		App.go(function () {
			var days = [];
			var byDate = {};
			slots.forEach(function (slot, index) {
				var start = parts(slot.start);
				if (!byDate[start.date]) {
					byDate[start.date] = el("div", "slot-day", null, el("div", "strong", dayLabel(start.date)));
					days.push(byDate[start.date]);
				}
				var node = button(range(slot), "btn slot" + (index === 0 ? " slot-best" : "") + (index === state.chosen ? " slot-on" : ""), function () {
					state.chosen = index;
					App.redraw();
				});
				byDate[start.date].appendChild(node);
			});
			var columns = el("div", "slot-days");
			days.forEach(function (day) {
				columns.appendChild(day);
			});
			var unchecked = Array.isArray(data.freeBusyUnavailableFor) ? data.freeBusyUnavailableFor.length : 0;
			var checked = Array.isArray(data.checked) ? data.checked.length : 0;
			var legend = el(
				"div",
				"legend",
				null,
				el("span", null, null, el("span", "key key-best"), el("span", null, "Best pick (earliest)")),
				el("span", null, null, el("span", "key"), el("span", null, "Everyone free"))
			);
			var chosen = state.chosen >= 0 ? slots[state.chosen] : null;
			var summary = chosen
				? "Chosen: " + dayLabel(parts(chosen.start).date) + ", " + range(chosen) + (data.timeZone ? " (" + data.timeZone + ")" : "")
				: slots.length
					? "Pick a time."
					: "No time fits everyone in this range.";
			var notes = [plural(checked, "calendar") + " checked, " + (Number(data.durationMinutes) || 0) + " minutes each."];
			notes.push("Only times when everyone is free are listed; times when someone is busy are left out.");
			if (unchecked) notes.push(plural(unchecked, "calendar") + " could not be read and " + (unchecked === 1 ? "is" : "are") + " not counted.");
			App.draw({
				tool: "suggest_time",
				account: account,
				line: App.argsLine(args),
				body: [slots.length ? columns : null, slots.length ? legend : null, el("div", "pad strong", summary)],
				actions: [chosen && bookSlot(chosen, args, account, data.timeZone)],
				note: notes.join(" "),
			});
		});
	});

	/** The "Find free time" form on the day view: asks who to meet, then calls suggest_time. */
	function findTimeScreen(day, zone, account) {
		var who = input("text", "");
		var minutes = select([["30", "30 minutes"], ["45", "45 minutes"], ["60", "1 hour"], ["90", "1.5 hours"]], "30");
		var status = el("div", "muted");
		App.go(function () {
			App.draw({
				tool: "suggest_time",
				account: account,
				line: "day: " + day,
				body: [el("div", "form", null, field("Who to meet (email addresses)", who), field("Length", minutes), status)],
				actions: [
					button("Find times", "btn btn-primary", function () {
						var emails = emailsIn(who.value);
						if (!emails.length) {
							status.textContent = "Enter at least one email address.";
							return;
						}
						var call = { account: account, attendeeEmails: emails, startTime: day + "T09:00:00", endTime: day + "T17:00:00", durationMinutes: Number(minutes.value) };
						if (zone) call.timeZone = zone;
						App.open("suggest_time", call, true);
					}),
				],
				note: "Looks at free and busy times only, from 9 AM to 5 PM on this day. Nothing is created or sent.",
			});
		});
	}

	/** The button under a chosen suggested time: opens the new-event form filled in. */
	function bookSlot(slot, args, account, zone) {
		if (!WRITES || !account) return null;
		return button("Book this time", "btn btn-primary", function () {
			var from = parts(slot.start);
			var until = parts(slot.end);
			createScreen(
				{
					day: from.date,
					start: clock(from.minutes),
					end: until && until.minutes !== null && until.date === from.date ? clock(until.minutes) : clock(Math.min(from.minutes + 30, 23 * 60 + 59)),
					guests: Array.isArray(args.attendeeEmails) ? emailsIn(args.attendeeEmails.join(", ")) : [],
					zone: zone || (typeof args.timeZone === "string" ? args.timeZone : ""),
				},
				account
			);
		});
	}

	App.start("GoBridge calendar", function (data) {
		if (Array.isArray(data.events)) return "list_events";
		if (Array.isArray(data.suggestions)) return "suggest_time";
		if (typeof data.eventId === "string" && typeof data.response === "string") return "respond_to_event";
		if (typeof data.eventId === "string") return "get_event";
		return "";
	});
})();
`;
