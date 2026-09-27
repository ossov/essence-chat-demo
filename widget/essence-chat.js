/**
 * Essence Chat — storefront widget (centered-pill layout).
 *
 * Resting state: a rounded pill input centered in the section. On the first
 * message it expands into a streaming conversation with a product card.
 *
 * Data attributes on the <script> tag (set by the theme section):
 *   data-endpoint       backend chat URL (e.g. https://<app>.vercel.app/api/chat)
 *   data-product-endpoint  optional; defaults to the chat URL with /chat -> /product
 *   data-mount          CSS selector of the container to render into (required)
 *   data-accent         accent color (hex); default #2A87B9
 *   data-placeholder    input placeholder; default "I'm feeling…"
 */
(function () {
  "use strict";

  var script = document.currentScript;

  // Remove any previous instance (theme-editor re-renders / double includes).
  var olds = document.querySelectorAll(".ec-stage, #ec-style");
  for (var oi = 0; oi < olds.length; oi++) {
    if (olds[oi].parentNode) olds[oi].parentNode.removeChild(olds[oi]);
  }

  function attr(name, fallback) {
    var v = script && script.getAttribute(name);
    return v && v.trim() ? v : fallback;
  }
  var ENDPOINT = attr("data-endpoint", "/apps/essence-chat");
  var PRODUCT_ENDPOINT =
    attr("data-product-endpoint", "") ||
    (/\/chat(-v\d+)?$/.test(ENDPOINT)
      ? ENDPOINT.replace(/\/chat(-v\d+)?$/, "/product")
      : ENDPOINT + "/product");
  var ACCENT = attr("data-accent", "#2A87B9");
  var PLACEHOLDER = attr("data-placeholder", "I'm feeling...");
  var mountSel = attr("data-mount", "");
  var mount = mountSel ? document.querySelector(mountSel) : null;
  if (!mount) return; // needs a container to render into

  // Load Nunito so the widget renders it even if the theme doesn't expose it.
  if (!document.getElementById("ec-font")) {
    var fontLink = document.createElement("link");
    fontLink.id = "ec-font";
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700&display=swap";
    document.head.appendChild(fontLink);
  }

  // --- styles (accent driven by a CSS variable) ---
  var css =
    ".ec-stage{--ec-accent:" + ACCENT + ";font-family:'Nunito',system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;width:100%;min-height:680px;padding:16px 0}" +
    ".ec-hero{width:100%;max-width:520px;transition:opacity .25s ease,transform .25s ease}" +
    ".ec-hero.ec-gone{opacity:0;transform:translateY(-10px);pointer-events:none}" +
    ".ec-panel{display:none;flex-direction:column;width:100%;max-width:700px;height:min(650px,80vh);background:#fdfcf8;border:1px solid #e3ddcf;border-radius:16px;overflow:hidden;opacity:0;transform:scale(.97);transition:opacity .3s ease,transform .3s ease;box-shadow:0 12px 40px rgba(0,0,0,.14)}" +
    ".ec-panel.ec-show{opacity:1;transform:scale(1)}" +
    ".ec-log{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:10px}" +
    ".ec-log,.ec-ta{scrollbar-width:none;-ms-overflow-style:none}" +
    ".ec-log::-webkit-scrollbar,.ec-ta::-webkit-scrollbar{display:none}" +
    ".ec-msg{flex-shrink:0;padding:9px 12px;border-radius:12px;max-width:85%;line-height:1.45;font-size:14px;white-space:pre-wrap;word-wrap:break-word}" +
    ".ec-user{align-self:flex-end;background:var(--ec-accent);color:#fff;border-bottom-right-radius:3px}" +
    ".ec-bot{align-self:flex-start;background:#efece2;color:#2c2c2c;border-bottom-left-radius:3px}" +
    ".ec-bot a{color:var(--ec-accent);font-weight:bold}" +
    ".ec-dots{color:#9a9a92;letter-spacing:2px}" +
    ".ec-disclaimer{font-size:11px;line-height:1.4;color:#9a9a92;text-align:center;padding:8px 16px}" +
    ".ec-reveal{animation:ecReveal .5s ease}" +
    "@keyframes ecReveal{from{opacity:0;filter:blur(6px)}to{opacity:1;filter:blur(0)}}" +
    ".ec-card{flex-shrink:0;align-self:flex-start;width:168px;max-width:100%;background:#fff;border:1px solid #e3ddcf;border-radius:12px;overflow:hidden}" +
    ".ec-card-img{display:block;width:100%;height:auto}" +
    ".ec-card-body{padding:12px 14px;text-align:center}" +
    ".ec-card-title{font-size:16px;font-weight:700;color:#2c2c2c}" +
    ".ec-card-res{font-size:13px;font-style:italic;color:#7a7a72;margin-top:3px}" +
    ".ec-card-btn{display:block;margin-top:12px;background:var(--ec-accent);color:#fff;text-decoration:none;padding:10px 0;border-radius:10px;font-size:14px;font-weight:700}";
  var style = document.createElement("style");
  style.id = "ec-style";
  style.textContent = css;
  document.head.appendChild(style);

  // Inline styles for the form controls so the theme's own input/button CSS
  // can't override the pill shape or accent.
  var ROW = "display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #e3ddcf;border-radius:999px;padding:6px 6px 6px 8px;box-shadow:0 10px 30px rgba(0,0,0,.16),0 2px 6px rgba(0,0,0,.08)";
  var HERO_INPUT = "flex:1;border:none;outline:none;background:#fff;color:#2c2c2c;font-family:inherit;font-size:15px;line-height:1.4;padding:11px 16px;border-radius:999px;box-sizing:border-box;resize:none;overflow-y:auto;max-height:132px;-webkit-appearance:none;appearance:none;color-scheme:light";
  var HERO_BTN = "border:none;background:" + ACCENT + ";border-radius:50%;width:44px;height:44px;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;-webkit-appearance:none;appearance:none";
  var FOOT = "display:flex;gap:8px;align-items:center;padding:12px;border-top:1px solid #e3ddcf;background:#fff";
  var CHAT_INPUT = "flex:1;border:1px solid #d6cfbe;outline:none;background:#fff;color:#2c2c2c;font-family:inherit;font-size:14px;line-height:1.4;padding:10px 14px;border-radius:999px;box-sizing:border-box;resize:none;overflow-y:auto;max-height:120px;-webkit-appearance:none;appearance:none;color-scheme:light";
  var CHAT_BTN = "border:none;background:" + ACCENT + ";border-radius:50%;width:40px;height:40px;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;-webkit-appearance:none;appearance:none";
  // White up-arrow icon for the send buttons (inline SVG — ASCII-safe, crisp at any size).
  var ARROW_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="6 11 12 5 18 11"></polyline></svg>';

  // --- DOM ---
  var stage = el("div", "ec-stage");

  var hero = el("div", "ec-hero");
  var heroForm = el("form", null, { style: ROW });
  var heroInput = el("textarea", "ec-ta", { placeholder: PLACEHOLDER, autocomplete: "off", rows: "1", style: HERO_INPUT });
  var heroBtn = el("button", null, { type: "submit", "aria-label": "Send", style: HERO_BTN });
  heroBtn.innerHTML = ARROW_SVG;
  heroForm.appendChild(heroInput);
  heroForm.appendChild(heroBtn);
  hero.appendChild(heroForm);

  var panel = el("div", "ec-panel");
  var log = el("div", "ec-log");
  var footForm = el("form", null, { style: FOOT });
  var chatInput = el("textarea", "ec-ta", { placeholder: PLACEHOLDER, autocomplete: "off", rows: "1", style: CHAT_INPUT });
  var chatBtn = el("button", null, { type: "submit", "aria-label": "Send", style: CHAT_BTN });
  chatBtn.innerHTML = ARROW_SVG;
  footForm.appendChild(chatInput);
  footForm.appendChild(chatBtn);
  // Medical disclaimer — sits at the bottom of the expanded panel, just above the
  // input. Lives inside the panel, so it only appears once the chat expands.
  var disclaimer = el("div", "ec-disclaimer");
  disclaimer.textContent = "This is not medical advice";
  panel.appendChild(log);
  panel.appendChild(disclaimer);
  panel.appendChild(footForm);

  stage.appendChild(hero);
  stage.appendChild(panel);
  mount.appendChild(stage);

  // --- state ---
  var messages = []; // [{ role, content }] sent to the backend
  var streaming = false;
  var opened = false;

  // --- events ---
  heroForm.addEventListener("submit", function (e) { e.preventDefault(); submit(heroInput); });
  footForm.addEventListener("submit", function (e) { e.preventDefault(); submit(chatInput); });

  // Auto-growing message boxes. Each box grows with its content up to the CSS
  // max-height (then scrolls), Enter sends / Shift+Enter adds a newline, and the
  // rounded corners soften once it's taller than one line so it stays clean.
  heroInput._pill = heroForm;   // hero: the surrounding pill is what grows
  chatInput._pill = chatInput;  // chat: the box itself is the pill
  [heroInput, chatInput].forEach(function (ta) {
    ta.addEventListener("input", function () { autoGrow(ta); });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit(ta);
      }
    });
  });

  function autoGrow(ta) {
    ta.style.height = "auto";
    var sh = ta.scrollHeight;
    ta.style.height = sh + "px";
    // Soften corners once taller than one line — keep the inner box and its
    // outer container at the same radius so they stay proportional.
    var cs = getComputedStyle(ta);
    var line = parseFloat(cs.lineHeight) || 20;
    var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var r = sh > pad + line * 1.5 ? "18px" : "999px";
    ta.style.borderRadius = r;
    if (ta._pill && ta._pill !== ta) ta._pill.style.borderRadius = r;
  }

  function submit(inputEl) {
    var text = inputEl.value.trim();
    if (!text || streaming) return;
    inputEl.value = "";
    autoGrow(inputEl); // collapse back to one line + restore the pill shape
    addUserMessage(text);
    messages.push({ role: "user", content: text });
    if (!opened) openPanel();
    sendToBackend();
  }

  function openPanel() {
    opened = true;
    hero.classList.add("ec-gone");
    setTimeout(function () {
      hero.style.display = "none";
      panel.style.display = "flex";
      requestAnimationFrame(function () {
        panel.classList.add("ec-show");
        chatInput.focus();
      });
    }, 230);
  }

  // Recent-history window sent to the backend. The full transcript stays on
  // screen; only this slice is sent, so a long chat can't outgrow the backend's
  // message cap (which used to wedge the chat permanently). Must begin with a
  // user turn — the API rejects a history starting on an assistant message.
  var MAX_SENT_MESSAGES = 40;
  function historyWindow() {
    var win = messages.slice(-MAX_SENT_MESSAGES);
    while (win.length && win[0].role !== "user") win.shift();
    return win.length ? win : messages.slice(-1);
  }

  function sendToBackend() {
    streaming = true;
    chatBtn.disabled = true;
    var botEl = addBotMessage('<span class="ec-dots">...</span>');
    var acc = "", done = false;

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: historyWindow() }),
    })
      .then(function (res) {
        if (!res.ok || !res.body) throw new Error("Request failed");
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";
        // Accumulate silently — the typing indicator stays until the full reply
        // is ready, then it reveals smoothly (no token-by-token jumps).
        function pump() {
          return reader.read().then(function (result) {
            if (result.done) return;
            buffer += decoder.decode(result.value, { stream: true });
            var events = buffer.split("\n\n");
            buffer = events.pop() || "";
            events.forEach(function (block) {
              var m = block.match(/data: (.*)/);
              if (!m) return;
              try {
                var payload = JSON.parse(m[1]);
                if (payload.delta) acc += payload.delta;
              } catch (_) {}
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {})
      .finally(finish);

    function finish() {
      if (done) return;
      done = true;
      if (acc) {
        var clean = stripCardMarkers(acc);
        botEl.innerHTML = linkify(clean);
        botEl.classList.add("ec-reveal");
        // Store the RAW reply (markers intact) in history. Sending back the
        // stripped text taught the model its own replies carry no [[card:...]]
        // line, so it stopped emitting them as a conversation grew.
        messages.push({ role: "assistant", content: acc });
        extractCardHandles(acc).slice(0, 1).forEach(function (h) {
          renderCard(h, botEl, clean);
        });
      } else {
        botEl.textContent = "Sorry - something went wrong. Please try again.";
        botEl.classList.add("ec-reveal");
      }
      streaming = false;
      chatBtn.disabled = false;
      log.scrollTop = log.scrollHeight;
    }
  }

  // --- helpers ---
  function addUserMessage(text) {
    var m = el("div", "ec-msg ec-user");
    m.textContent = text;
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
  }
  function addBotMessage(html) {
    var m = el("div", "ec-msg ec-bot");
    m.innerHTML = html;
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }
  function el(tag, className, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function stripCardMarkers(text) {
    var t = text.replace(/\[\[card:[^\]]*\]\]/g, "");
    var i = t.indexOf("[[");
    if (i !== -1 && t.indexOf("]]", i) === -1) t = t.slice(0, i);
    if (t.charAt(t.length - 1) === "[") t = t.slice(0, -1);
    return t.replace(/\s+$/, "");
  }
  function extractCardHandles(text) {
    var out = [], seen = {}, re = /\[\[card:([^\]]+)\]\]/g, m;
    while ((m = re.exec(text))) {
      var h = m[1].trim();
      if (h && !seen[h]) { seen[h] = 1; out.push(h); }
    }
    return out;
  }

  function renderCard(handle, botEl, replyText) {
    var sep = PRODUCT_ENDPOINT.indexOf("?") >= 0 ? "&" : "?";
    fetch(PRODUCT_ENDPOINT + sep + "handle=" + encodeURIComponent(handle))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) {
        if (!p) return; // no card if the product can't be resolved

        // Finalize the reply text right away (bold the product name); only the
        // card itself waits for its image.
        if (botEl && replyText && p.title) {
          botEl.innerHTML = linkify(boldName(replyText, p.title));
          log.scrollTop = log.scrollHeight;
        }

        // Build the card off-DOM (no reveal class yet — it stays out of the log
        // until its image has actually decoded, so the whole thing fades in as
        // one piece instead of the image popping in a beat later).
        var card = el("div", "ec-card");
        var img = null;
        if (p.image) {
          img = el("img", "ec-card-img", { src: p.image, alt: p.title || "" });
          card.appendChild(img);
        }
        var body = el("div", "ec-card-body");
        var title = el("div", "ec-card-title");
        title.textContent = p.title || handle;
        body.appendChild(title);
        if (p.resonance) {
          var res = el("div", "ec-card-res");
          res.textContent = p.resonance;
          body.appendChild(res);
        }
        var btn = el("a", "ec-card-btn", { href: p.url || "/products/" + handle, target: "_blank", rel: "noopener" });
        btn.textContent = "Learn more";
        body.appendChild(btn);
        card.appendChild(body);

        // Reveal once: append with the blur-in animation and scroll into view.
        var revealed = false;
        function reveal() {
          if (revealed) return;
          revealed = true;
          card.classList.add("ec-reveal");
          log.appendChild(card);
          log.scrollTop = log.scrollHeight;
        }

        if (img) {
          // Prefer decode() so the image is fully painted before the fade-in.
          if (img.decode) {
            img.decode().then(reveal).catch(reveal);
          } else {
            img.onload = reveal;
            img.onerror = reveal;
          }
          // Safety net: never wait on a slow/broken image longer than 2.5s.
          setTimeout(reveal, 2500);
        } else {
          reveal();
        }
      })
      .catch(function () {});
  }

  function boldName(text, name) {
    if (!name) return text;
    var esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp("\\*\\*\\s*" + esc + "\\s*\\*\\*", "gi"), name);
    return text.replace(new RegExp(esc, "gi"), "**" + name + "**");
  }

  function linkify(text) {
    var esc = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    esc = esc.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    esc = esc.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    // Clickable crisis directory — the model emits it bare (e.g. "findahelpline.com").
    // Opens in a new tab so the chat stays put.
    esc = esc.replace(
      /\b((?:https?:\/\/)?(?:www\.)?findahelpline\.com[^\s<),."']*)/gi,
      function (url) {
        var href = /^https?:\/\//i.test(url) ? url : "https://" + url;
        return '<a href="' + href + '" target="_blank" rel="noopener">' + url + "</a>";
      },
    );
    return esc.replace(/(\/products\/[a-z0-9\-]+)/gi, function (path) {
      return '<a href="' + path + '">' + path + "</a>";
    });
  }
})();
