/**
 * Calendar tools (PARITY.md): 9 tools matching Google's Calendar connector.
 * Guests are never emailed unless notificationLevel is passed explicitly.
 */
import { z } from "zod";
import { randomToken } from "../crypto";
import { googleJson, googleRequest, ToolError } from "../google-api";
import {
	account,
	calendarId,
	cap,
	CONFIRM,
	DEFAULT_TIME_ZONE,
	email,
	formatInZone,
	googleId,
	LIMITS,
	notificationLevel,
	pageSize,
	pageToken,
	sendUpdatesFor,
	singleLine,
	timestamp,
	timeZone,
	tool,
	type ToolContext,
	UNTRUSTED,
	untrusted,
} from "./common";

const CALENDAR = "https://www.googleapis.com/calendar/v3";
const EVENT_ID = "event id (or calendar id)";
type CalendarEvent = Record<string, any>;

const eventsUrl = (calendar: string, eventId: string | null, query: Record<string, string> = {}) => {
	const url = new URL(`${CALENDAR}/calendars/${encodeURIComponent(calendar)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`);
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	return url;
};

function shapeEvent(event: CalendarEvent, zone: string, descriptionChars: number) {
	const guests: any[] = Array.isArray(event.attendees) ? event.attendees : [];
	return {
		eventId: event.id,
		status: event.status,
		summary: untrusted("calendar", cap(event.summary, LIMITS.headerChars)),
		description: untrusted("calendar", cap(event.description, descriptionChars)),
		location: untrusted("calendar", cap(event.location, LIMITS.headerChars)),
		start: formatInZone(event.start?.dateTime, zone) ?? event.start?.date,
		end: formatInZone(event.end?.dateTime, zone) ?? event.end?.date,
		allDay: Boolean(event.start?.date),
		timeZone: zone,
		organizer: cap(event.organizer?.email, LIMITS.headerChars),
		creator: cap(event.creator?.email, LIMITS.headerChars),
		attendees: guests.slice(0, LIMITS.attendees).map((a) => ({
			email: cap(a?.email, LIMITS.headerChars),
			displayName: untrusted("calendar", cap(a?.displayName, LIMITS.headerChars)),
			responseStatus: a?.responseStatus,
			optional: a?.optional === true ? true : undefined,
			resource: a?.resource === true ? true : undefined,
			self: a?.self === true ? true : undefined,
		})),
		attendeesOmitted: Math.max(0, guests.length - LIMITS.attendees),
		recurrence: Array.isArray(event.recurrence) ? event.recurrence.slice(0, 10) : undefined,
		recurringEventId: event.recurringEventId,
		hangoutLink: event.hangoutLink,
		visibility: event.visibility,
		transparency: event.transparency,
		colorId: event.colorId,
		eventType: event.eventType,
		reminders: event.reminders,
		attachments: Array.isArray(event.attachments)
			? event.attachments.slice(0, 20).map((a: any) => ({ fileUrl: a?.fileUrl, title: untrusted("calendar", cap(a?.title, 200)) }))
			: undefined,
		htmlLink: event.htmlLink,
		updated: event.updated,
	};
}

// ---------- Input mapping ----------

const eventTime = z.union([timestamp, z.iso.date()]);
const attendeeInput = z.object({
	email,
	displayName: singleLine(200).optional(),
	optionalAttendee: z.boolean().optional(),
	resource: z.boolean().optional(),
});
const attachmentInput = z.object({ fileUrl: z.url().max(2048), title: singleLine(200).optional() });
const reminderInput = z.object({ method: z.enum(["email", "popup"]), minutes: z.number().int().min(0).max(40_320) });

const eventFields = {
	calendarId,
	timeZone,
	allDay: z.boolean().optional(),
	description: z.string().max(LIMITS.eventDescriptionChars).optional(),
	location: singleLine(LIMITS.headerChars).optional(),
	attendees: z.array(attendeeInput).max(LIMITS.attendees).optional(),
	addGoogleMeetUrl: z.boolean().optional().describe("Create a Google Meet link for the event"),
	googleMeetUrl: z.url().max(2048).optional().describe("Use an existing Meet link (added to the description and location)"),
	recurrenceData: z.array(z.string().max(500)).max(10).optional().describe('RRULE lines, e.g. "RRULE:FREQ=WEEKLY;COUNT=10"'),
	overrideReminders: z.array(reminderInput).max(5).optional(),
	useDefaultReminders: z.boolean().optional(),
	availability: z.enum(["busy", "free"]).optional(),
	visibility: z.enum(["default", "public", "private", "confidential"]).optional(),
	colorId: z.string().regex(/^(1[01]|[1-9])$/).optional().describe("Calendar colour id 1-11"),
	eventType: z.enum(["default", "outOfOffice", "focusTime", "workingLocation"]).optional(),
	guestPermissions: z
		.object({ canModify: z.boolean().optional(), canInviteOthers: z.boolean().optional(), canSeeOtherGuests: z.boolean().optional() })
		.optional(),
	attachments: z.array(attachmentInput).max(20).optional(),
	notificationLevel,
};

const toTime = (value: string, zone: string, allDay?: boolean) =>
	allDay || value.length === 10 ? { date: value.slice(0, 10) } : { dateTime: value, timeZone: zone };

const hasOffset = (value: string) => /(Z|[+-]\d{2}:\d{2})$/.test(value);
function checkTimes(start?: string, end?: string, allDay?: boolean) {
	if (!start || !end) return;
	if (!allDay && (start.length === 10) !== (end.length === 10)) {
		throw new ToolError("invalid_input", "Invalid input: startTime and endTime must both be times or both be dates.");
	}
	if (hasOffset(start) === hasOffset(end) && Date.parse(end) < Date.parse(start)) {
		throw new ToolError("invalid_input", "Invalid input: endTime must not be before startTime.");
	}
}

const mapAttendee = (a: z.infer<typeof attendeeInput>) => ({
	email: a.email,
	...(a.displayName ? { displayName: a.displayName } : {}),
	...(a.optionalAttendee ? { optional: true } : {}),
	...(a.resource ? { resource: true } : {}),
});

/** Converts the tool's fields into a Google event body (only the fields given). */
function eventBody(args: Partial<z.infer<z.ZodObject<typeof eventFields>>> & { summary?: string; startTime?: string; endTime?: string }) {
	const zone = args.timeZone ?? DEFAULT_TIME_ZONE;
	const body: CalendarEvent = {};
	if (args.summary !== undefined) body.summary = args.summary;
	if (args.startTime) body.start = toTime(args.startTime, zone, args.allDay);
	if (args.endTime) body.end = toTime(args.endTime, zone, args.allDay);
	if (args.description !== undefined) body.description = args.description;
	if (args.location !== undefined) body.location = args.location;
	if (args.attendees) body.attendees = args.attendees.map(mapAttendee);
	if (args.addGoogleMeetUrl) {
		body.conferenceData = { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" }, requestId: randomToken(12) } };
	}
	if (args.googleMeetUrl) {
		body.description = `${body.description ?? args.description ?? ""}\n\nGoogle Meet: ${args.googleMeetUrl}`.trim();
		if (!args.location) body.location = args.googleMeetUrl;
	}
	if (args.recurrenceData) body.recurrence = args.recurrenceData;
	if (args.overrideReminders) body.reminders = { overrides: args.overrideReminders, useDefault: false };
	else if (args.useDefaultReminders !== undefined) body.reminders = { useDefault: args.useDefaultReminders };
	if (args.availability) body.transparency = args.availability === "free" ? "transparent" : "opaque";
	if (args.visibility) body.visibility = args.visibility;
	if (args.colorId) body.colorId = args.colorId;
	if (args.eventType) body.eventType = args.eventType;
	if (args.guestPermissions) {
		const g = args.guestPermissions;
		if (g.canModify !== undefined) body.guestsCanModify = g.canModify;
		if (g.canInviteOthers !== undefined) body.guestsCanInviteOthers = g.canInviteOthers;
		if (g.canSeeOtherGuests !== undefined) body.guestsCanSeeOtherGuests = g.canSeeOtherGuests;
	}
	if (args.attachments) body.attachments = args.attachments.map((a) => ({ fileUrl: a.fileUrl, ...(a.title ? { title: a.title } : {}) }));
	return body;
}

function noteEvent(ctx: ToolContext, args: { calendarId: string; notificationLevel: "NONE" | "ALL" | "EXTERNAL_ONLY" }, event?: CalendarEvent) {
	ctx.audit.calendarId = args.calendarId;
	ctx.audit.sendUpdates = sendUpdatesFor(args.notificationLevel);
	if (event?.id) ctx.audit.eventId = event.id;
	if (typeof event?.summary === "string") ctx.audit.summary = event.summary;
}

const writeQuery = (level: "NONE" | "ALL" | "EXTERNAL_ONLY") => ({
	conferenceDataVersion: "1",
	sendUpdates: sendUpdatesFor(level),
	supportsAttachments: "true",
});

// ---------- suggest_time helpers ----------

type Busy = { start: number; end: number };

function localParts(instant: number, zone: string): { hour: number; weekday: number } {
	const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: zone, weekday: "short" }).formatToParts(
		new Date(instant),
	);
	const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
	const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "Sun");
	return { hour, weekday };
}

/** Free slots of `duration` minutes inside [start, end] that avoid every busy interval. */
export function findFreeSlots(
	start: number,
	end: number,
	durationMinutes: number,
	busy: Busy[],
	zone: string,
	prefs: { startHour: number; endHour: number; excludeWeekends: boolean; pageSize: number },
): { start: number; end: number }[] {
	const slots: { start: number; end: number }[] = [];
	const step = 15 * 60_000;
	const length = durationMinutes * 60_000;
	for (let t = Math.ceil(start / step) * step; t + length <= end && slots.length < prefs.pageSize; t += step) {
		const { hour, weekday } = localParts(t, zone);
		const endLocal = localParts(t + length - 1, zone);
		if (prefs.excludeWeekends && (weekday === 0 || weekday === 6)) continue;
		if (hour < prefs.startHour || endLocal.hour >= prefs.endHour || endLocal.hour < hour) continue;
		if (busy.some((b) => b.start < t + length && b.end > t)) continue;
		slots.push({ end: t + length, start: t });
		t += length - step; // next candidate starts after this slot
	}
	return slots;
}

// ---------- Tools ----------

export const CALENDAR_TOOLS = [
	tool({
		name: "list_calendars",
		title: "List calendars",
		description: `Lists the calendars this account can see (id, name, access role, time zone). ${UNTRUSTED}`,
		kind: "read",
		countKey: "calendars",
		schema: z.object({ account, pageSize: pageSize(250, 50), pageToken }),
		run: async (env, args) => {
			const url = new URL(`${CALENDAR}/users/me/calendarList`);
			url.searchParams.set("maxResults", String(args.pageSize));
			if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
			const data = await googleJson<{ items?: CalendarEvent[]; nextPageToken?: string }>(env, args.account, url, { what: "page token" });
			return {
				calendars: (data.items ?? []).slice(0, args.pageSize).map((c) => ({
					calendarId: c.id,
					summary: untrusted("calendar", cap(c.summaryOverride ?? c.summary, LIMITS.headerChars)),
					description: untrusted("calendar", cap(c.description, LIMITS.eventListDescriptionChars)),
					primary: c.primary === true,
					accessRole: c.accessRole,
					timeZone: c.timeZone,
					backgroundColor: c.backgroundColor,
					selected: c.selected,
				})),
				nextPageToken: data.nextPageToken,
			};
		},
	}),

	tool({
		name: "list_events",
		title: "List calendar events",
		description: `Lists events on one calendar between startTime and endTime, recurring events expanded. fullText filters by words; eventType filters by kind. Up to 250 events per page. ${UNTRUSTED}`,
		kind: "read",
		countKey: "events",
		schema: z.object({
			account,
			calendarId,
			startTime: timestamp.optional(),
			endTime: timestamp.optional(),
			fullText: z.string().trim().max(500).optional(),
			eventType: z.array(z.enum(["default", "outOfOffice", "focusTime", "workingLocation", "birthday", "fromGmail"])).max(6).optional(),
			orderBy: z.enum(["startTime", "updated"]).default("startTime"),
			pageSize: pageSize(250, 25),
			pageToken,
			timeZone,
		}),
		run: async (env, args) => {
			if (args.startTime && args.endTime && hasOffset(args.startTime) === hasOffset(args.endTime) && Date.parse(args.endTime) <= Date.parse(args.startTime)) {
				throw new ToolError("invalid_input", "Invalid input: endTime must be after startTime.");
			}
			const url = eventsUrl(args.calendarId, null, {
				maxResults: String(args.pageSize),
				orderBy: args.orderBy,
				singleEvents: "true",
				timeZone: args.timeZone,
			});
			if (args.startTime) url.searchParams.set("timeMin", args.startTime);
			if (args.endTime) url.searchParams.set("timeMax", args.endTime);
			if (args.fullText) url.searchParams.set("q", args.fullText);
			if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
			for (const type of args.eventType ?? []) url.searchParams.append("eventTypes", type);
			const data = await googleJson<{ items?: CalendarEvent[]; nextPageToken?: string }>(env, args.account, url, { what: "calendar id or time range" });
			return {
				events: (data.items ?? []).slice(0, args.pageSize).map((e) => shapeEvent(e, args.timeZone, LIMITS.eventListDescriptionChars)),
				nextPageToken: data.nextPageToken,
			};
		},
	}),

	tool({
		name: "search_events",
		title: "Search calendar events",
		description: `Keyword search over the primary calendar's events (title, description, location, attendees). ${UNTRUSTED}`,
		kind: "read",
		countKey: "events",
		schema: z.object({ account, query: z.string().trim().min(1).max(500), pageSize: pageSize(250, 25), pageToken, timeZone }),
		run: async (env, args) => {
			const url = eventsUrl("primary", null, { maxResults: String(args.pageSize), orderBy: "startTime", q: args.query, singleEvents: "true", timeZone: args.timeZone });
			if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
			const data = await googleJson<{ items?: CalendarEvent[]; nextPageToken?: string }>(env, args.account, url, { what: "search query" });
			return {
				events: (data.items ?? []).slice(0, args.pageSize).map((e) => shapeEvent(e, args.timeZone, LIMITS.eventListDescriptionChars)),
				nextPageToken: data.nextPageToken,
			};
		},
	}),

	tool({
		name: "get_event",
		title: "Get one calendar event",
		description: `Returns one calendar event with its description, attendees, reminders and attachments. ${UNTRUSTED}`,
		kind: "read",
		schema: z.object({ account, eventId: googleId("Calendar event id"), calendarId, timeZone }),
		run: async (env, args) =>
			shapeEvent(await googleJson<CalendarEvent>(env, args.account, eventsUrl(args.calendarId, args.eventId), { what: EVENT_ID }), args.timeZone, LIMITS.eventDescriptionChars),
	}),

	tool({
		name: "create_event",
		title: "Create a calendar event",
		description: `Creates a calendar event. Times are read in timeZone (default ${DEFAULT_TIME_ZONE}) unless they carry an offset; allDay uses the dates only. By default NO invitation emails are sent, even with attendees. ${CONFIRM}`,
		kind: "write",
		schema: z.object({ account, summary: singleLine(LIMITS.headerChars).min(1), startTime: eventTime, endTime: eventTime, ...eventFields }),
		run: async (env, args, ctx) => {
			checkTimes(args.startTime, args.endTime, args.allDay);
			noteEvent(ctx, args);
			ctx.audit.summary = args.summary;
			const event = await googleJson<CalendarEvent>(env, args.account, eventsUrl(args.calendarId, null, writeQuery(args.notificationLevel)), {
				json: eventBody(args),
				method: "POST",
				what: "calendar id or event details",
			});
			noteEvent(ctx, args, event);
			return { ...shapeEvent(event, args.timeZone, LIMITS.eventDescriptionChars), attendeesEmailed: args.notificationLevel !== "NONE" };
		},
	}),

	tool({
		name: "update_event",
		title: "Update a calendar event",
		description: `Changes the given fields of a calendar event; fields you leave out are kept. attendees replaces the whole guest list; addedAttendees/removedAttendeeEmails adjust it. By default NO emails are sent. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({
			account,
			eventId: googleId("Calendar event id"),
			summary: singleLine(LIMITS.headerChars).min(1).optional(),
			startTime: eventTime.optional(),
			endTime: eventTime.optional(),
			...eventFields,
			addedAttendees: z.array(attendeeInput).max(LIMITS.attendees).optional(),
			removedAttendeeEmails: z.array(email).max(LIMITS.attendees).optional(),
			addedAttachments: z.array(attachmentInput).max(20).optional(),
			removedAttachmentFileUrls: z.array(z.url().max(2048)).max(20).optional(),
		}),
		run: async (env, args, ctx) => {
			checkTimes(args.startTime, args.endTime, args.allDay);
			noteEvent(ctx, args);
			ctx.audit.eventId = args.eventId;
			const body = eventBody(args);
			const needsCurrent = args.addedAttendees || args.removedAttendeeEmails || args.addedAttachments || args.removedAttachmentFileUrls;
			if (needsCurrent) {
				const current = await googleJson<CalendarEvent>(env, args.account, eventsUrl(args.calendarId, args.eventId), { what: EVENT_ID });
				const removed = new Set((args.removedAttendeeEmails ?? []).map((a) => a.toLowerCase()));
				const guests: any[] = body.attendees ?? (Array.isArray(current.attendees) ? current.attendees : []);
				body.attendees = [
					...guests.filter((g) => !removed.has(String(g?.email ?? "").toLowerCase())),
					...(args.addedAttendees ?? []).map(mapAttendee).filter((a) => !guests.some((g) => String(g?.email ?? "").toLowerCase() === a.email.toLowerCase())),
				];
				const dropped = new Set(args.removedAttachmentFileUrls ?? []);
				const files: any[] = body.attachments ?? (Array.isArray(current.attachments) ? current.attachments : []);
				body.attachments = [
					...files.filter((f) => !dropped.has(f?.fileUrl)),
					...(args.addedAttachments ?? []).map((a) => ({ fileUrl: a.fileUrl, ...(a.title ? { title: a.title } : {}) })),
				];
			}
			if (Object.keys(body).length === 0) throw new ToolError("invalid_input", "Invalid input: give at least one field to change.");
			const event = await googleJson<CalendarEvent>(env, args.account, eventsUrl(args.calendarId, args.eventId, writeQuery(args.notificationLevel)), {
				json: body,
				method: "PATCH",
				what: EVENT_ID,
			});
			noteEvent(ctx, args, event);
			return { ...shapeEvent(event, args.timeZone, LIMITS.eventDescriptionChars), attendeesEmailed: args.notificationLevel !== "NONE" };
		},
	}),

	tool({
		name: "delete_event",
		title: "Delete a calendar event",
		description: `Deletes a calendar event. By default NO cancellation emails are sent. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({ account, eventId: googleId("Calendar event id"), calendarId, notificationLevel }),
		run: async (env, args, ctx) => {
			noteEvent(ctx, args);
			ctx.audit.eventId = args.eventId;
			// Read it first so the audit log can say what was deleted.
			const event = await googleJson<CalendarEvent>(env, args.account, eventsUrl(args.calendarId, args.eventId), { what: EVENT_ID });
			noteEvent(ctx, args, event);
			await googleRequest(env, args.account, eventsUrl(args.calendarId, args.eventId, { sendUpdates: sendUpdatesFor(args.notificationLevel) }), {
				method: "DELETE",
				what: EVENT_ID,
			}).then((r) => r.body?.cancel());
			return { deleted: true, eventId: args.eventId, summary: untrusted("calendar", cap(event.summary, LIMITS.headerChars)), attendeesEmailed: args.notificationLevel !== "NONE" };
		},
	}),

	tool({
		name: "respond_to_event",
		title: "Respond to a calendar invitation",
		description: `Sets this account's own response (accepted, declined, tentative) on an event it is invited to, with an optional comment. By default no emails are sent. ${CONFIRM}`,
		kind: "write",
		schema: z.object({
			account,
			eventId: googleId("Calendar event id"),
			responseStatus: z.enum(["accepted", "declined", "tentative", "needsAction"]),
			calendarId,
			responseComment: singleLine(1000).optional(),
			notificationLevel,
		}),
		run: async (env, args, ctx) => {
			noteEvent(ctx, args);
			ctx.audit.eventId = args.eventId;
			ctx.audit.response = args.responseStatus;
			const event = await googleJson<CalendarEvent>(env, args.account, eventsUrl(args.calendarId, args.eventId), { what: EVENT_ID });
			noteEvent(ctx, args, event);
			const guests: any[] = Array.isArray(event.attendees) ? event.attendees : [];
			if (!guests.some((g) => g?.self === true)) {
				throw new ToolError("invalid_input", "This account is not an invited guest on that event, so there is nothing to respond to.");
			}
			const updated = await googleJson<CalendarEvent>(env, args.account, eventsUrl(args.calendarId, args.eventId, { sendUpdates: sendUpdatesFor(args.notificationLevel) }), {
				json: {
					attendees: guests.map((g) =>
						g?.self === true ? { ...g, responseStatus: args.responseStatus, ...(args.responseComment !== undefined ? { comment: args.responseComment } : {}) } : g,
					),
				},
				method: "PATCH",
				what: EVENT_ID,
			});
			return { ...shapeEvent(updated, DEFAULT_TIME_ZONE, LIMITS.eventListDescriptionChars), response: args.responseStatus };
		},
	}),

	tool({
		name: "suggest_time",
		title: "Suggest meeting times",
		description: `Finds free slots for this account and the given attendees between startTime and endTime, using their free/busy information. Nothing is created or sent.`,
		kind: "read",
		countKey: "suggestions",
		schema: z.object({
			account,
			attendeeEmails: z.array(email).min(1).max(LIMITS.attendees),
			startTime: timestamp,
			endTime: timestamp,
			durationMinutes: z.number().int().min(5).max(24 * 60).default(30),
			timeZone,
			preferences: z
				.object({
					startHour: z.number().int().min(0).max(23).default(9),
					endHour: z.number().int().min(1).max(24).default(17),
					excludeWeekends: z.boolean().default(true),
					pageSize: z.number().int().min(1).max(50).default(10),
				})
				.default({ endHour: 17, excludeWeekends: true, pageSize: 10, startHour: 9 }),
		}),
		run: async (env, args, ctx) => {
			const start = Date.parse(args.startTime);
			const end = Date.parse(args.endTime);
			if (!(end > start)) throw new ToolError("invalid_input", "Invalid input: endTime must be after startTime.");
			if (end - start > 62 * 24 * 3_600_000) throw new ToolError("invalid_input", "Invalid input: the range may span at most 62 days.");
			if (args.preferences.endHour <= args.preferences.startHour) throw new ToolError("invalid_input", "Invalid input: endHour must be after startHour.");
			const ids = [...new Set([ctx.accountEmail.toLowerCase(), ...args.attendeeEmails.map((a) => a.toLowerCase())])].filter(Boolean);
			const data = await googleJson<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(
				env,
				args.account,
				`${CALENDAR}/freeBusy`,
				{
					json: { items: ids.map((id) => ({ id })), timeMax: new Date(end).toISOString(), timeMin: new Date(start).toISOString(), timeZone: args.timeZone },
					method: "POST",
					what: "attendee emails or time range",
				},
			);
			const busy: Busy[] = [];
			const unavailable: string[] = [];
			for (const id of ids) {
				const entry = data.calendars?.[id];
				if (!entry || entry.errors?.length) unavailable.push(id);
				for (const b of entry?.busy ?? []) busy.push({ end: Date.parse(b.end), start: Date.parse(b.start) });
			}
			const slots = findFreeSlots(start, end, args.durationMinutes, busy, args.timeZone, args.preferences);
			return {
				suggestions: slots.map((s) => ({ start: formatInZone(new Date(s.start).toISOString(), args.timeZone), end: formatInZone(new Date(s.end).toISOString(), args.timeZone) })),
				timeZone: args.timeZone,
				durationMinutes: args.durationMinutes,
				checked: ids,
				freeBusyUnavailableFor: unavailable,
			};
		},
	}),
];
