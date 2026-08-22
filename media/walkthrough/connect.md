# Point the extension at your system

The one thing tying the extension to a system is the **launch URL** — the URL
that starts an abap2UI5 app, with `{class}` as the placeholder for the class
name:

```
https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100
```

Set it once — the first F9 also asks for it. Working against more than one
system? Name them in `abap2ui5.systems` and switch with *"abap2UI5: Select
System"*; the choice is remembered per window.

Credentials (the ones you use in ADT) are asked for once and kept in VS
Code's SecretStorage.

Not sure the URL is right? Run *"abap2UI5: Check System Connection"* — it
probes the endpoint step by step (URL shape, host, logon, ICF path, page
content) and says which step fails and what fixes it, instead of leaving
you with a white preview.
