- **A system with an IPv6 address works.** A launch URL such as
  `https://[fd00::10]:44300/...` failed every request with "the hostname does
  not resolve (DNS)": the brackets of the address travelled into the name
  lookup. The preview, the ADT lookups and WebSocket upgrades now connect to
  the address itself.
- **A launch URL typed without its scheme is refused where it is typed.**
  `host:44300/sap/bc/z2ui5?app_start={class}` parses as a URL - with the
  scheme `host:` - so it was accepted, the credentials were stored under the
  origin "null" ("SAP User for null"), and the launch then failed with
  "Invalid URL". A template has to be http or https now.
- **A wrong password no longer lets a WebSocket-using app hammer the system.**
  An app that reopens its WebSocket after the system refused the logon sent
  one failed logon per attempt - the burst that locks an account - and the
  offer to re-enter the credentials never came, because the refusal was not
  reported. The upgrade path now trips the same breaker as every other
  request and reports the 401.
- **WebSocket tunnels are cleaned up when the app gives up first.** A client
  that hung up before the system answered left both ends of the pending
  upgrade open until the proxy stopped.
- **The proxy is stricter about what it forwards and who may ask.** An
  absolute-form request (`GET http://127.0.0.1:<port>/...`) used to be
  forwarded to the system verbatim, token segment included; it is refused. A
  request authorized only by the proxy's cookie is accepted only from the page
  the cookie was planted for - a cross-site `<img>`, iframe or form on another
  local port is refused, told apart by the browser's own `Sec-Fetch-Site`. And
  the `Referer` of a page loaded through a one-shot screenshot URL is
  rewritten to the system's origin like every other, instead of carrying the
  one-shot token on to the system.
- **System cookies scoped to a path work through the proxy.** A cookie the
  system set with `Path=/sap/bc/z2ui5` was never sent back, because the
  proxied requests live under `/__abap2ui5/<token>/...`; the path is rewritten
  to `/`, on pages and on WebSocket handshakes alike. A root-relative redirect
  (`Location: /sap/bc/...`) now lands behind the token too, rather than on the
  cookie alone.
- **The system MCP server ignores browsers.** A request carrying an `Origin`
  header - a page made it, not an MCP client - is answered 404, and a POST
  whose body is not declared `application/json` gets 415, so a cross-site
  "simple" POST can no longer reach a tool.
- **Screenshots: unique file names, no credentials on the command line.** Two
  shots within one second no longer overwrite each other (the name carries
  milliseconds and a counter), and a launch URL carrying `sap-user` or
  `sap-password` has them stripped before the page URL is handed to Chromium
  - the proxy injects the credentials anyway.
- **Class descriptions from the system show `&`, `<` and quotes correctly** in
  "Run an App from the System"; they arrived entity-escaped (`&amp;`) and were
  shown that way.
- **A pasted SAP user is trimmed** before it is stored, so a trailing space
  cannot turn every logon into a failure until the credentials are reset.
- **"Preview View (No System)" survives an empty `viewCheck.command`.** Set
  to `""`, the checker start threw instead of reporting that nothing could be
  started; it is reported like any other failed start now, and a `taskkill`
  that cannot start on Windows no longer surfaces as an uncaught error.
