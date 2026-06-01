# ChatGPT Drive Sync

Chrome extension MVP that syncs ChatGPT conversations to Google Drive only.

## Sync Model

- EventStream completion is used as the change trigger.
- `GET /backend-api/conversation/{conversation_id}` is used as the source of truth.
- Each sync overwrites the same Drive files:
  - `conversations/{chat_title}.json`
- `index.json` tracks synced conversations.

## Google Setup

1. Create a Google Cloud project.
2. Enable the Google Drive API.
3. Configure OAuth consent screen.
4. Load this extension once from `chrome://extensions` so Chrome shows its extension id.
5. Create an OAuth client for a Chrome extension.
   - Application type: Chrome extension / Chrome app.
   - Application ID: the extension id shown in `chrome://extensions`.
6. Copy the generated client id into `manifest.json`.

```json
"oauth2": {
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/drive.file"]
}
```

Use the exact extension id from `chrome://extensions` when creating the OAuth client. If the client was created for a different extension id, Chrome returns `bad client id`.

## OAuth Troubleshooting

`OAuth2 request failed: Service responded with error: 'bad client id: {0}'` means one of these is true:

- `manifest.json` still has the placeholder client id.
- The OAuth client was not created as a Chrome extension/client.
- The OAuth client's application id does not match the id shown in `chrome://extensions`.
- The extension was reloaded from a different path/profile and now has a different id.

After changing `manifest.json`, click Reload on the extension in `chrome://extensions` before trying Connect again.

## Load Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder.
5. Open extension options and connect Google Drive.

## Diagnostics

Click the extension icon to open the popup. It shows:

- current sync/auth status
- recent diagnostic logs
- Connect button
- Sync Current button for the active ChatGPT conversation tab
- Check Drive button to list the extension's Drive folder contents
- Copy Logs button for sharing diagnostics

The options page shows the same status plus a larger recent-log JSON view.

After a successful sync, ChatGPT shows a small notification-style card for about 1.2 seconds.

## Notes

This extension uploads only normalized chat content:

- conversation id
- title
- timestamps
- active visible user/assistant messages

## Security Notes

- Google OAuth uses Chrome Identity with `https://www.googleapis.com/auth/drive.file`.
- The OAuth client id is public and must be configured in `manifest.json`; Chrome Identity does not support changing it from the options page at runtime.
- ChatGPT bearer/cookie headers are never stored in `chrome.storage` and are never uploaded to Drive.
- Diagnostic logs redact common sensitive fields and are kept locally in `chrome.storage.local`.
- The extension does not load remote JavaScript.

It does not upload HAR files, cookies, auth headers, telemetry, tool messages, or system messages.
