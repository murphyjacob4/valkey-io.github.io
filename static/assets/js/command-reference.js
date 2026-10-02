/*
 * Shared logic for the command reference (/commands/) and the command page
 * sidebar (/commands/<name>/): entry parsing, search ranking, similarity
 * scoring, list rendering and keyboard handling.
 *
 * Entries are <li> elements containing `<code><a>NAME</a></code>` and a
 * `.command-summary` (or `.command-list-summary`) span, which provide the
 * name and summary, plus these data attributes:
 *   data-slug       page slug, e.g. "client-list"
 *   data-group      group key from groups.json, e.g. "sorted-set"
 *   data-container  lower-cased container for subcommands, e.g. "client" (optional)
 *   data-acl        space-separated lower-cased ACL categories, excluding
 *                   broad ones like read/write/fast/slow/keyspace (optional)
 *   data-rank       1-based position in popular_commands (optional)
 *   data-deprecated "true" for deprecated commands (optional)
 *   data-replaced-by slug of the replacement for a deprecated command, from
 *                   the command JSON's replaced_by field (optional)
 */
(() => {
    "use strict";

    const STOPWORDS = new Set(("a an the of to and or in on at by for from with as is are be it its if that this " +
        "one more all any key keys value values return returns given specified new when not does exist exists " +
        "using based their them then than into").split(" "));

    /*
     * Similarity (see similarity() below). Each other command is scored against
     * the current one:
     *
     *   +6  same container (sibling subcommands)        CLIENT LIST ~ CLIENT KILL
     *   +6  parent/child container                      CLIENT ~ CLIENT LIST
     *   +3  same group                                  HGET ~ HLEN
     *   +3  name variant in the same namespace          GET ~ GETEX, MGET (not SET ~ RESET,
     *       (container, module prefix or top-level)     GET ~ JSON.GET)
     *   +2  otherwise, same subcommand, other container CLIENT LIST ~ ACL LIST
     *   +1  per shared non-generic ACL category         @hash, @pubsub, @blocking
     *   ~0-5 shared summary words + 4 * Jaccard, halved across groups
     *   -3  deprecated
     *   +20 the replacement of the current (deprecated) command, so it ranks first
     *                                                   SLAVEOF -> REPLICAOF
     *
     * Commands below MIN_SIMILARITY are dropped and at most MAX_SIMILAR are
     * kept. The summary term makes most scores fractional, so the popularity
     * and name tie-breaks rarely apply. The same-group bonus alone reaches
     * MIN_SIMILARITY, so the threshold only filters commands from other groups
     * (and deprecated ones).
     */
    const MIN_SIMILARITY = 3;
    const MAX_SIMILAR = 50;

    const normalizeQuery = (query) => query.toLowerCase().replace(/\s+/g, " ").trim();

    const tokens = (text) => new Set(text.split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w))
        .map((w) => w.replace(/s$/, "")));

    const overlap = (a, b) => {
        let shared = 0;
        a.forEach((x) => { if (b.has(x)) shared++; });
        return shared;
    };

    const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

    // Splits a command into its namespace and base name. The namespace is the
    // container for subcommands ("client list" -> "client" / "list") or the
    // module prefix for dotted names ("json.get" -> "json" / "get").
    const splitName = (name, container) => {
        if (container) return { namespace: container, base: name.slice(container.length + 1) };
        const dot = name.indexOf(".");
        if (dot > 0) return { namespace: name.slice(0, dot), base: name.slice(dot + 1) };
        return { namespace: "", base: name };
    };

    const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim().toLowerCase() : "");

    const parseEntry = (el, groupNames) => {
        const d = el.dataset;
        const name = text(el.querySelector("code a"));
        const summary = text(el.querySelector(".command-summary, .command-list-summary"));
        const container = d.container || "";
        const { namespace, base } = splitName(name, container);
        return {
            el,
            name,
            slug: d.slug,
            summary,
            group: d.group,
            groupName: ((groupNames && groupNames[d.group]) || d.group || "").toLowerCase(),
            container,
            namespace,
            base,
            words: name.split(/[\s.\-_]+/),
            acl: new Set(d.acl ? d.acl.split(" ") : []),
            summaryTokens: tokens(summary),
            rank: d.rank ? parseInt(d.rank, 10) : Infinity,
            deprecated: d.deprecated === "true",
            replacedBy: d.replacedBy || ""
        };
    };

    // Search ranking: lower is better, -1 means no match.
    const searchScore = (entry, query, terms) => {
        if (entry.name === query || entry.slug === query) return 0;
        if (entry.name.startsWith(query)) return 1;
        if (entry.words.some((w) => w.startsWith(query))) return 2;
        if (entry.name.includes(query)) return 3;
        const haystack = `${entry.name} ${entry.summary} ${entry.groupName}`;
        if (terms.every((t) => haystack.includes(t))) return 4;
        return -1;
    };

    // Order within the same score: non-deprecated first, then popularity, then name.
    // (Infinity - Infinity is NaN, which is falsy, so unranked pairs fall through to the name.)
    const compareEntries = (a, b) => (a.deprecated - b.deprecated) || (a.rank - b.rank) || byName(a, b);

    // Returns entries matching `query` (all entries if the query is empty), best first.
    const search = (entries, query) => {
        const q = normalizeQuery(query);
        const terms = q.split(" ").filter(Boolean);
        return entries
            .map((entry) => ({ entry, score: q ? searchScore(entry, q, terms) : 0 }))
            .filter((m) => m.score >= 0)
            .sort((a, b) => (a.score - b.score) || compareEntries(a.entry, b.entry))
            .map((m) => m.entry);
    };

    // True if one name is a prefix of the other (GET -> GETEX), or is the other
    // with exactly one leading character added (GET -> MGET/HGET, LPOP -> BLPOP).
    // SET -> RESET doesn't match: that would need a two-character prefix.
    const isNameVariant = (a, b) => {
        if (a.length < 3 || b.length < 3 || a === b) return false;
        const [shorter, longer] = a.length > b.length ? [b, a] : [a, b];
        const at = longer.indexOf(shorter);
        if (at === 0) return true;                                    // GET -> GETEX, GETDEL
        return at === 1 && at + shorter.length === longer.length;     // GET -> MGET, HGET
    };

    // Similarity to `current`: higher is more similar.
    const similarity = (current, e) => {
        let s = 0;
        if (current.container && e.container === current.container) s += 6; // Sibling subcommands.
        if (e.container && e.container === current.name) s += 6;            // This page is the parent.
        if (current.container && current.container === e.name) s += 6;      // Link back to the parent.
        const sameGroup = e.group === current.group;
        if (sameGroup) s += 3;
        if (e.namespace === current.namespace && isNameVariant(e.base, current.base)) s += 3;
        else if (e.container && current.container && e.base === current.base) s += 2; // CLIENT LIST ~ ACL LIST
        s += overlap(e.acl, current.acl);
        // Shared description words; discounted across groups so one common word doesn't dominate.
        const shared = overlap(e.summaryTokens, current.summaryTokens);
        const union = e.summaryTokens.size + current.summaryTokens.size - shared;
        if (union) s += (shared + 4 * shared / union) * (sameGroup ? 1 : 0.5);
        if (e.deprecated) s -= 3;
        if (current.replacedBy && e.slug === current.replacedBy) s += 20;
        return s;
    };

    const mostSimilar = (entries, current) => entries
        .filter((e) => e !== current)
        .map((e) => ({ e, s: similarity(current, e) }))
        .filter((m) => m.s >= MIN_SIMILARITY)
        .sort((a, b) => (b.s - a.s) || (a.e.rank - b.e.rank) || byName(a.e, b.e))
        .slice(0, MAX_SIMILAR)
        .map((m) => m.e);

    // Shows `visible` (in order) and hides every other entry.
    const showEntries = (listEl, entries, visible) => {
        const visibleSet = new Set(visible);
        visible.forEach((entry) => listEl.appendChild(entry.el));
        entries.forEach((entry) => { entry.el.hidden = !visibleSet.has(entry); });
    };

    const updateShowMore = (button, remaining, pageSize) => {
        button.hidden = remaining <= 0;
        button.textContent = `Show ${Math.min(pageSize, remaining)} more`;
    };

    const isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

    // "/" focuses the search box unless the user is typing somewhere or using a modifier.
    const bindSlashShortcut = (searchBox) => {
        document.addEventListener("keydown", (event) => {
            if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
            if (isEditable(document.activeElement)) return;
            event.preventDefault();
            searchBox.focus();
        });
    };

    // Enter opens the top result (only for a non-empty query); Escape clears the box.
    const bindSearchKeys = (searchBox, listEl) => {
        searchBox.addEventListener("keydown", (event) => {
            if (event.isComposing) return;
            if (event.key === "Enter") {
                if (!normalizeQuery(searchBox.value)) return;
                const first = listEl.querySelector("li:not([hidden]) a");
                if (first) window.location.href = first.href;
            } else if (event.key === "Escape" && searchBox.value) {
                event.preventDefault(); // Avoid the browser's own clear running a second time.
                searchBox.value = "";
                searchBox.dispatchEvent(new Event("input"));
            }
        });
    };

    const scrollToElement = (el) => {
        const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    };

    // Returns a debounced wrapper around `fn`, plus `.now()` to run it immediately
    // (cancelling any pending call).
    const debounce = (fn, delay = 300) => {
        let timer = null;
        const debounced = (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
        debounced.now = (...args) => {
            clearTimeout(timer);
            fn(...args);
        };
        return debounced;
    };

    // Returns a setter for an aria-live status element. Updates are debounced
    // so screen readers announce once typing pauses rather than on every
    // keystroke; pass `immediate` for the initial render and clicks.
    const liveStatus = (el, delay = 300) => {
        const set = debounce((message) => { el.textContent = message; }, delay);
        return (message, immediate) => (immediate ? set.now(message) : set(message));
    };

    // history.replaceState that never throws. Safari raises a SecurityError
    // after ~100 calls in a short window; losing a URL update is harmless.
    const replaceUrl = (url) => {
        try {
            history.replaceState(null, "", url);
        } catch (e) {
            // Ignore: the page state is still correct, only the URL is stale.
        }
    };

    window.ValkeyCommandReference = {
        parseEntry,
        normalizeQuery,
        search,
        mostSimilar,
        showEntries,
        updateShowMore,
        bindSlashShortcut,
        bindSearchKeys,
        scrollToElement,
        debounce,
        liveStatus,
        replaceUrl
    };
})();
