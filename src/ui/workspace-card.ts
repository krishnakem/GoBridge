/**
 * Workspace card (ui://gobridge/workspace.html): read_doc, get_values,
 * read_presentation and read_slide_page_thumbnail.
 *
 * Everything read from a file (text, cells, formulas, comments, slide text,
 * speaker notes) is shown as plain text. The slide image is the PNG GoBridge
 * fetched server-side and returned as MCP image content; the card shows it
 * from a data: URL, which is why this card's own policy says img-src data:
 * and nothing else. No URL from a file is ever loaded or made clickable. The
 * one link is "Open in Docs / Sheets / Slides", built from the file id on
 * docs.google.com and opened through the host's ui/open-link.
 */

export const WORKSPACE_CSS = String.raw`
.doc { display: flex; align-items: flex-start; }
.outline { flex: none; width: 190px; display: flex; flex-direction: column; padding: 8px; border-right: 1px solid var(--line); max-height: 520px; overflow-y: auto; }
.outline-item { all: unset; box-sizing: border-box; min-height: 30px; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.outline-item:hover, .outline-on { background: var(--bg-soft); }
.outline-on { font-weight: 600; }
.indent-2 { padding-left: 18px; }
.indent-3 { padding-left: 28px; }
.doc-main { flex: 1; min-width: 0; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; max-height: 520px; overflow-y: auto; }
.para { margin: 0; white-space: pre-wrap; }
.h1 { font-size: 18px; font-weight: 700; }
.h2 { font-size: 16px; font-weight: 700; }
.h3 { font-size: 14px; font-weight: 700; }
.bullet::before { content: "• "; }
.ins { color: var(--good); text-decoration: underline; }
.del { color: var(--bad); text-decoration: line-through; }
.comment { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.quote { border-left: 3px solid var(--line); padding-left: 8px; color: var(--muted); font-size: 12px; }
.reply { padding-left: 12px; font-size: 13px; }
.sheet-wrap { overflow: auto; max-height: 420px; }
.sheet { border-collapse: collapse; font-size: 13px; width: 100%; }
.sheet th, .sheet td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; vertical-align: top; }
.sheet th { background: var(--bg-soft); position: sticky; top: 0; padding: 0; }
.sort { all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 32px; padding: 6px 8px; font-weight: 600; cursor: pointer; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.sheet td.num { text-align: right; }
.neg { color: var(--bad); }
.chart { display: flex; flex-direction: column; gap: 4px; padding: 12px 16px; border-top: 1px solid var(--line); }
.bar-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.bar-label { flex: none; width: 110px; }
.bar-track { flex: 1; height: 14px; background: var(--bg-soft); border-radius: 4px; overflow: hidden; }
.bar { height: 100%; background: var(--accent); border-radius: 4px; }
.bar-neg { background: var(--bad); }
.bar-value { flex: none; width: 70px; text-align: right; font-variant-numeric: tabular-nums; }
.grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding: 12px 16px; }
.slide { all: unset; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; height: 92px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; cursor: pointer; font-size: 11px; background: var(--bg-soft); }
.slide-on { border: 2px solid var(--accent); }
.slide-number { font-weight: 700; color: var(--muted); }
.thumb { display: block; max-width: 100%; height: auto; margin: 0 auto; border: 1px solid var(--line); border-radius: 8px; }
.thumb-nav { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 10px 16px; }
.dots { display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; }
.pip { width: 8px; height: 8px; border-radius: 50%; background: var(--line); }
.pip-on { background: var(--accent); }
@media (max-width: 480px) {
	.doc { flex-direction: column; }
	.outline { width: 100%; border-right: 0; border-bottom: 1px solid var(--line); max-height: 140px; }
	.grid4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;

export const WORKSPACE_JS = String.raw`
(function () {
	var DOCS_HOSTS = ["docs.google.com"];
	var MAX_ROWS = 200;
	var MAX_COLUMNS = 30;

	function isId(value) {
		return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
	}
	function copy(args) {
		var out = {};
		Object.keys(args || {}).forEach(function (key) {
			out[key] = args[key];
		});
		return out;
	}
	/** Google's own editor address for a file id, or "" for anything that is not an id. */
	function editorLink(kind, id) {
		return isId(id) ? "https://docs.google.com/" + kind + "/d/" + id + "/edit" : "";
	}
	function hasIds(value) {
		return Array.isArray(value) && value.length > 0;
	}

	// ---------- Docs ----------

	function runsOf(paragraph) {
		var runs = [];
		(Array.isArray(paragraph.elements) ? paragraph.elements : []).forEach(function (element) {
			var run = element && element.textRun;
			if (run && typeof run.content === "string") {
				runs.push({ text: run.content, ins: hasIds(run.suggestedInsertionIds), del: hasIds(run.suggestedDeletionIds) });
			} else if (element && element.inlineObjectElement) {
				runs.push({ text: "[image]" });
			}
		});
		if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\n$/, "");
		return runs;
	}
	function plainText(content) {
		var out = [];
		(Array.isArray(content) ? content : []).forEach(function (element) {
			if (element && element.paragraph) {
				out.push(
					runsOf(element.paragraph)
						.map(function (run) {
							return run.text;
						})
						.join("")
				);
			}
		});
		return out.join("\n");
	}
	function blocksOf(content, out) {
		(Array.isArray(content) ? content : []).forEach(function (element) {
			if (!element) return;
			if (element.paragraph) {
				var style = element.paragraph.paragraphStyle && element.paragraph.paragraphStyle.namedStyleType;
				var match = /^HEADING_([1-6])$/.exec(String(style || ""));
				var level = style === "TITLE" ? 1 : match ? Number(match[1]) : 0;
				var runs = runsOf(element.paragraph);
				if (runs.length) out.push({ kind: "p", runs: runs, level: level, bullet: !!element.paragraph.bullet });
			} else if (element.table) {
				var rows = (Array.isArray(element.table.tableRows) ? element.table.tableRows : []).map(function (row) {
					return (Array.isArray(row && row.tableCells) ? row.tableCells : []).map(function (cell) {
						return plainText(cell && cell.content);
					});
				});
				out.push({ kind: "table", rows: rows });
			}
		});
		return out;
	}
	function blockText(block) {
		return block.runs
			.map(function (run) {
				return run.text;
			})
			.join("");
	}
	function blockNode(block) {
		if (block.kind === "table") {
			var table = el("table", "sheet");
			var tbody = el("tbody");
			block.rows.slice(0, MAX_ROWS).forEach(function (row) {
				var tr = el("tr");
				row.slice(0, MAX_COLUMNS).forEach(function (cell) {
					tr.appendChild(el("td", null, cell));
				});
				tbody.appendChild(tr);
			});
			table.appendChild(tbody);
			return el("div", "sheet-wrap", null, table);
		}
		var level = Math.min(block.level, 3);
		var node = el("p", "para" + (level ? " h" + level : "") + (block.bullet ? " bullet" : ""));
		block.runs.forEach(function (run) {
			node.appendChild(el("span", run.del ? "del" : run.ins ? "ins" : null, run.text));
		});
		return node;
	}
	function commentNode(comment) {
		var node = el("div", "comment", null, el("div", "row", null, el("span", "strong", comment.author || "Someone"), comment.resolved ? el("span", "tag", "Resolved") : null));
		if (comment.quoted) node.appendChild(el("div", "quote", comment.quoted));
		if (comment.content) node.appendChild(el("div", "text", comment.content));
		(Array.isArray(comment.replies) ? comment.replies : []).forEach(function (reply) {
			node.appendChild(el("div", "reply", (reply.author || "Someone") + ": " + (reply.content || "")));
		});
		return node;
	}

	App.view("read_doc", function (parsed, args, account) {
		var data = parsed.data;
		var blocks = [];
		if (Array.isArray(data.tabs)) {
			data.tabs.forEach(function (tab) {
				blocksOf(tab && tab.documentTab && tab.documentTab.body && tab.documentTab.body.content, blocks);
			});
		} else {
			blocksOf(data.body && data.body.content, blocks);
		}
		var headings = [];
		blocks.forEach(function (block, index) {
			if (block.kind === "p" && block.level) headings.push({ index: index, level: block.level, text: blockText(block) });
		});
		var comments = Array.isArray(data.comments) ? data.comments : [];
		var marked = blocks.some(function (block) {
			return block.kind === "p" && block.runs.some(function (run) {
				return run.ins || run.del;
			});
		});
		var state = { section: -1 };
		function reopen(change, replace) {
			var next = copy(args);
			Object.keys(change).forEach(function (key) {
				next[key] = change[key];
			});
			App.open("read_doc", next, replace);
		}

		App.go(function () {
			var outline = el("div", "outline");
			var whole = button("Whole page", "outline-item" + (state.section === -1 ? " outline-on" : ""), function () {
				state.section = -1;
				App.redraw();
			});
			outline.appendChild(whole);
			headings.forEach(function (heading, position) {
				var item = button(clip(heading.text, 80) || "Untitled section", "outline-item indent-" + Math.min(heading.level, 3) + (state.section === position ? " outline-on" : ""), function () {
					state.section = position;
					App.redraw();
				});
				outline.appendChild(item);
			});
			var from = 0;
			var to = blocks.length;
			if (state.section >= 0 && headings[state.section]) {
				from = headings[state.section].index;
				for (var i = state.section + 1; i < headings.length; i++) {
					if (headings[i].level <= headings[state.section].level) {
						to = headings[i].index;
						break;
					}
				}
			}
			var main = el("div", "doc-main");
			blocks.slice(from, to).forEach(function (block) {
				main.appendChild(blockNode(block));
			});
			if (!blocks.length) main.appendChild(el("div", "muted", "This page of the document has no text."));
			if (comments.length && state.section === -1) {
				main.appendChild(el("div", "strong", plural(comments.length, "comment")));
				comments.forEach(function (comment) {
					main.appendChild(commentNode(comment));
				});
			}
			var inline = args.suggestionsViewMode === "SUGGESTIONS_INLINE";
			var notes = ["Renders as plain text. Links and images in the document are not loaded."];
			if (marked) notes.push("Suggested additions are underlined; suggested deletions are struck through.");
			if (data.nextPageToken) notes.push("This is one page of a longer document.");
			App.draw({
				tool: "read_doc",
				account: account,
				line: App.argsLine(args),
				body: [el("div", "pad title", data.title || "Document"), el("div", "doc", null, headings.length ? outline : null, main)],
				actions: [
					account
						? button(inline ? "Hide suggestions" : "Show suggestions", "btn", function () {
								reopen({ suggestionsViewMode: inline ? "PREVIEW_WITHOUT_SUGGESTIONS" : "SUGGESTIONS_INLINE" }, true);
							})
						: null,
					account && data.nextPageToken
						? button("Next page", "btn", function () {
								reopen({ pageToken: data.nextPageToken }, false);
							})
						: null,
					linkButton("Open in Docs", editorLink("document", data.documentId || args.documentId), DOCS_HOSTS, "btn btn-primary"),
				],
				note: notes.join(" "),
			});
		});
	});

	// ---------- Sheets ----------

	/** The number a cell shows, or null when it is not a number. */
	function numberOf(value) {
		if (typeof value === "number") return isFinite(value) ? value : null;
		if (typeof value !== "string") return null;
		var text = value.trim();
		var negative = /^\(.*\)$/.test(text);
		text = text.replace(/[()$€£,%\s]/g, "");
		if (!/^-?\d*\.?\d+$/.test(text)) return null;
		var number = Number(text);
		return isFinite(number) ? (negative ? -Math.abs(number) : number) : null;
	}
	function cellText(value) {
		return value === undefined || value === null ? "" : String(value);
	}

	App.view("get_values", function (parsed, args, account) {
		var data = parsed.data;
		var grid = (Array.isArray(data.values) ? data.values : []).filter(Array.isArray);
		var header = (grid[0] || []).slice(0, MAX_COLUMNS);
		var state = { sort: -1, down: false };
		var formulas = args.valueRenderOption === "FORMULA";

		function sortedRows() {
			var rows = grid.slice(1);
			if (state.sort < 0) return rows;
			var column = state.sort;
			return rows.slice().sort(function (a, b) {
				var x = numberOf(a[column]);
				var y = numberOf(b[column]);
				var order = x !== null && y !== null ? x - y : cellText(a[column]).localeCompare(cellText(b[column]));
				return state.down ? -order : order;
			});
		}
		/** The first column that is mostly numbers, and the first that is mostly words. */
		function chartColumns(rows) {
			var value = -1;
			var label = -1;
			for (var column = 0; column < header.length; column++) {
				var numbers = 0;
				var filled = 0;
				rows.forEach(function (row) {
					if (cellText(row[column]) === "") return;
					filled++;
					if (numberOf(row[column]) !== null) numbers++;
				});
				if (!filled) continue;
				if (value < 0 && numbers / filled >= 0.6) value = column;
				if (label < 0 && numbers / filled < 0.6) label = column;
			}
			return { value: value, label: label };
		}

		App.go(function () {
			var rows = sortedRows();
			var table = el("table", "sheet");
			var head = el("tr");
			header.forEach(function (name, column) {
				var arrow = state.sort === column ? (state.down ? " ▼" : " ▲") : "";
				var sorter = button(cellText(name) + arrow, "sort", function () {
					state.down = state.sort === column ? !state.down : false;
					state.sort = column;
					App.redraw();
				});
				head.appendChild(el("th", null, null, sorter));
			});
			table.appendChild(el("thead", null, null, head));
			var tbody = el("tbody");
			rows.slice(0, MAX_ROWS).forEach(function (row) {
				var tr = el("tr");
				for (var column = 0; column < header.length; column++) {
					var number = formulas ? null : numberOf(row[column]);
					tr.appendChild(el("td", number === null ? null : "num" + (number < 0 ? " neg" : ""), cellText(row[column])));
				}
				tbody.appendChild(tr);
			});
			table.appendChild(tbody);

			var chart = null;
			var columns = formulas ? { value: -1, label: -1 } : chartColumns(rows);
			if (columns.value >= 0 && rows.length > 1) {
				var shown = rows.slice(0, 12);
				var max = 0;
				shown.forEach(function (row) {
					max = Math.max(max, Math.abs(numberOf(row[columns.value]) || 0));
				});
				chart = el("div", "chart", null, el("div", "strong", cellText(header[columns.value]) || "Values"));
				shown.forEach(function (row, index) {
					var number = numberOf(row[columns.value]);
					if (number === null) return;
					var bar = el("div", "bar" + (number < 0 ? " bar-neg" : ""));
					bar.style.setProperty("width", (max ? (Math.abs(number) / max) * 100 : 0) + "%");
					chart.appendChild(
						el(
							"div",
							"bar-row",
							null,
							el("span", "bar-label clip", columns.label >= 0 ? cellText(row[columns.label]) : "Row " + (index + 2)),
							el("div", "bar-track", null, bar),
							el("span", "bar-value" + (number < 0 ? " neg" : ""), cellText(row[columns.value]))
						)
					);
				});
			}
			var notes = ["Cells render as plain text. Select a column heading to sort."];
			if (formulas) notes.push("Showing formulas as text; they are not run here.");
			if (data.truncated) notes.push("Only part of the range fits in one answer (10,000 cells). Ask for a narrower range.");
			if (rows.length > MAX_ROWS || (grid[0] || []).length > MAX_COLUMNS) notes.push("Showing the first " + MAX_ROWS + " rows and " + MAX_COLUMNS + " columns.");
			if (chart && rows.length > 12) notes.push("The chart shows the first 12 rows.");
			App.draw({
				tool: "get_values",
				account: account,
				line: App.argsLine(args),
				body: [grid.length ? el("div", "sheet-wrap", null, table) : el("p", "note", "This range is empty."), chart],
				actions: [
					state.sort >= 0
						? button("Clear sort", "btn", function () {
								state.sort = -1;
								App.redraw();
							})
						: null,
					account
						? button(formulas ? "Show values" : "Show formulas", "btn", function () {
								var next = copy(args);
								if (formulas) delete next.valueRenderOption;
								else next.valueRenderOption = "FORMULA";
								App.open("get_values", next, true);
							})
						: null,
					typeof addRowButton === "function" ? addRowButton(data, args, account, grid) : null,
					linkButton("Open in Sheets", editorLink("spreadsheets", data.spreadsheetId || args.spreadsheetId), DOCS_HOSTS, "btn btn-primary"),
				],
				note: notes.join(" "),
			});
		});
	});

	// ---------- Slides ----------

	function runText(text) {
		return (Array.isArray(text && text.textElements) ? text.textElements : [])
			.map(function (element) {
				return element && element.textRun && typeof element.textRun.content === "string" ? element.textRun.content : "";
			})
			.join("")
			.trim();
	}
	function elementText(elements, out, depth) {
		if (depth > 8) return out;
		(Array.isArray(elements) ? elements : []).forEach(function (element) {
			if (!element) return;
			if (element.shape && element.shape.text) {
				var text = runText(element.shape.text);
				if (text) out.push(text);
			}
			if (element.table) {
				(Array.isArray(element.table.tableRows) ? element.table.tableRows : []).forEach(function (row) {
					var cells = (Array.isArray(row && row.tableCells) ? row.tableCells : []).map(function (cell) {
						return runText(cell && cell.text);
					});
					if (cells.join("")) out.push(cells.join(" | "));
				});
			}
			if (element.elementGroup) elementText(element.elementGroup.children, out, depth + 1);
		});
		return out;
	}
	function slideInfo(slide) {
		var notesPage = slide && slide.slideProperties && slide.slideProperties.notesPage;
		return {
			id: slide && slide.objectId,
			text: elementText(slide && slide.pageElements, [], 0).join("\n"),
			notes: elementText(notesPage && notesPage.pageElements, [], 0).join("\n"),
		};
	}
	/** The slides the card has seen for one presentation: lets the image view page through them. */
	var deck = { id: "", slides: [] };
	function remember(presentationId, slides, append) {
		var infos = (Array.isArray(slides) ? slides : []).map(slideInfo).filter(function (info) {
			return isId(info.id);
		});
		deck = { id: presentationId, slides: append && deck.id === presentationId ? deck.slides.concat(infos) : infos };
	}

	App.view("read_presentation", function (parsed, args, account) {
		var data = parsed.data;
		var id = data.presentationId || args.presentationId;
		var offset = /^s(\d{1,6})$/.exec(String(args.pageToken || ""));
		var first = offset ? Number(offset[1]) : 0;
		var slides = (Array.isArray(data.slides) ? data.slides : []).map(slideInfo);
		remember(id, data.slides, first > 0);
		var state = { chosen: 0 };
		App.go(function () {
			var grid = el("div", "grid4");
			slides.forEach(function (slide, index) {
				var tile = button("", "slide" + (index === state.chosen ? " slide-on" : ""), function () {
					state.chosen = index;
					App.redraw();
				});
				tile.appendChild(el("span", "slide-number", "Slide " + (first + index + 1)));
				tile.appendChild(el("span", null, clip(slide.text, 90) || "No text"));
				grid.appendChild(tile);
			});
			var chosen = slides[state.chosen];
			var detail = chosen
				? el(
						"div",
						"pad stack",
						null,
						el("div", "strong", "Slide " + (first + state.chosen + 1)),
						el("pre", "text", chosen.text || "This slide has no text."),
						el("div", "strong", "Speaker notes"),
						el("pre", "text", chosen.notes || "No speaker notes.")
					)
				: null;
			var total = Number(data.slideCount) || slides.length;
			App.draw({
				tool: "read_presentation",
				account: account,
				line: App.argsLine(args),
				body: [el("div", "pad stack", null, el("div", "title", data.title || "Presentation"), el("div", "muted", plural(total, "slide"))), slides.length ? grid : el("p", "note", "No slides on this page."), detail],
				actions: [
					account && chosen && isId(chosen.id) && isId(id)
						? button("Show slide image", "btn", function () {
								App.open("read_slide_page_thumbnail", { account: account, presentationId: id, pageId: chosen.id });
							})
						: null,
					account && data.nextPageToken
						? button("Next page", "btn", function () {
								var next = copy(args);
								next.pageToken = data.nextPageToken;
								App.open("read_presentation", next, false);
							})
						: null,
					linkButton("Open in Slides", editorLink("presentation", id), DOCS_HOSTS, "btn btn-primary"),
				],
				note: "Tiles are built from each slide's text, not from images. Slide text renders as plain text.",
			});
		});
	});

	App.view("read_slide_page_thumbnail", function (parsed, args, account) {
		var info = parsed.data;
		var image = parsed.image;
		var presentationId = info.presentationId || args.presentationId;
		var pageId = info.pageId || args.pageId;
		var state = { notice: "" };
		function show(target) {
			var call = { account: account, presentationId: presentationId, pageId: target };
			if (args.thumbnailProperties && typeof args.thumbnailProperties === "object") call.thumbnailProperties = args.thumbnailProperties;
			App.open("read_slide_page_thumbnail", call, true);
		}
		function loadList() {
			state.notice = "Loading the slide list…";
			App.redraw();
			App.call("read_presentation", {
				account: account,
				presentationId: presentationId,
				fields: ["presentationId", "slides.objectId", "slides.slideProperties.notesPage.pageElements.shape.text"],
			}).then(function (result) {
				state.notice = result.error || "";
				if (result.data) remember(presentationId, result.data.slides, false);
				App.redraw();
			});
		}
		App.go(function () {
			var body = [];
			// Only a PNG that arrived as MCP image content is shown, from a data: URL.
			var usable = image && image.mimeType === "image/png" && typeof image.data === "string" && /^[A-Za-z0-9+\/]+={0,2}$/.test(image.data);
			if (usable) {
				var picture = document.createElement("img");
				picture.className = "thumb";
				picture.alt = "Slide image";
				picture.src = "data:image/png;base64," + image.data;
				body.push(el("div", "pad", null, picture));
			} else {
				body.push(el("p", "note", "The slide image is not available."));
			}
			var known = deck.id === presentationId && deck.slides.length > 0;
			var index = -1;
			if (known) {
				deck.slides.forEach(function (slide, position) {
					if (slide.id === pageId) index = position;
				});
			}
			if (known && index >= 0) {
				var previous = iconButton("left", "Previous slide", function () {
					show(deck.slides[index - 1].id);
				});
				previous.disabled = index === 0;
				var next = iconButton("right", "Next slide", function () {
					show(deck.slides[index + 1].id);
				});
				next.disabled = index === deck.slides.length - 1;
				var dots = el("div", "dots");
				deck.slides.slice(0, 40).forEach(function (slide, position) {
					dots.appendChild(el("span", "pip" + (position === index ? " pip-on" : "")));
				});
				body.push(el("div", "thumb-nav", null, previous, el("span", "muted", "Slide " + (index + 1) + " of " + deck.slides.length), next));
				body.push(dots);
				body.push(el("div", "pad stack", null, el("div", "strong", "Speaker notes"), el("pre", "text", deck.slides[index].notes || "No speaker notes.")));
			}
			var size = Number(info.widthPx) && Number(info.heightPx) ? Number(info.widthPx) + " × " + Number(info.heightPx) + " px" : "";
			App.draw({
				tool: "read_slide_page_thumbnail",
				account: account,
				line: App.argsLine(args),
				body: body,
				actions: [!known && account && isId(presentationId) ? button("Load slide list", "btn", loadList) : null, linkButton("Open in Slides", editorLink("presentation", presentationId), DOCS_HOSTS, "btn btn-primary")],
				note: (state.notice ? state.notice + " " : "") + "GoBridge fetched this image from Google; the card loads nothing itself." + (size ? " " + size + "." : ""),
			});
		});
	});

	/** Phase 3 replaces this with the button that opens the add-row form. */
	var addRowButton = null;

	App.start("GoBridge Workspace", function (data) {
		if (data.body || Array.isArray(data.tabs)) return "read_doc";
		if (Array.isArray(data.values)) return "get_values";
		if (Array.isArray(data.slides)) return "read_presentation";
		if (typeof data.pageId === "string") return "read_slide_page_thumbnail";
		return "";
	});
})();
`;
