(function () {
  "use strict";
  var el = document.getElementById("contact");
  fetch("/api/config")
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (d) {
      var c = (d && d.contact) || "";
      if (!c) { el.textContent = "連絡先は準備中です。"; return; }
      el.textContent = "";
      if (/^https?:\/\//i.test(c)) {
        var a = document.createElement("a");
        a.href = c; a.textContent = c; a.rel = "noopener noreferrer";
        el.appendChild(a);
      } else {
        el.textContent = c;
      }
    })
    .catch(function () { el.textContent = "連絡先は準備中です。"; });
})();
