# Deploying the agent with MDM (Intune, Jamf, Kandji)

AGT-01 (MDM part), issue #86. For IT teams that install AI Proctor on company computers without the employee doing anything but signing in.

> **Pending #55 / #56.** The signed, notarized macOS `.pkg` (#55) and the Windows `.msi` (#56) don't exist yet, so the installer steps below are marked _pending_. Everything about the enrollment token (creating it, the managed preference, the registry value, what the agent does with it) works today with the debug bundle.

## How it works

1. An owner or admin creates an **enrollment token** in the dashboard: **People → Device enrollment → New enrollment token**. The token (`apet_` followed by 43 characters) is shown once; copy it into your MDM straight away. The database keeps only a hash of it.
2. Your MDM installs the agent and delivers the token as managed configuration (macOS managed preference, Windows policy registry value).
3. The employee opens AI Proctor and signs in with their work email (magic link). On that first sign-in the agent registers the computer with the token. The server checks that:
   - the token is one of your org's, and
   - the person who signed in belongs to the same org.
   Anyone from another org is refused and signed out: a managed computer only enrolls people from the org that manages it, and a token never moves anyone into an org.
4. The dashboard shows how many devices each token enrolled and when it was last used. Creating a token, revoking it and every enrollment are in the **Audit log** ("Created an enrollment token", "Revoked an enrollment token", "Enrolled a device").

Revoking a token stops **new** enrollments with it. Computers it already enrolled keep working; to stop one of those, remove that device (or deactivate the person).

The token is not a password. It is readable on the managed computer (macOS managed preferences and the HKLM registry are readable by local users) and only ever works together with a real sign-in by someone in your org. Still, treat it as internal: keep it in your MDM, not in tickets or chat. To rotate: create a new token, update the profile or registry value, check that new installs enroll, then revoke the old one.

## The setting

| | macOS | Windows |
|---|---|---|
| Where | Managed preference, domain `com.aiproctor.agent` | `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\AIProctor\Agent` |
| Name | `EnrollmentToken` | `EnrollmentToken` |
| Type | String | `REG_SZ` |
| Value | the token, e.g. `apet_AbCd…` | the token |

The agent reads it at every launch. On macOS it only accepts a value delivered by a configuration profile (a forced, managed preference); a value set with `defaults write` is ignored. On Windows it only reads `HKEY_LOCAL_MACHINE` (64-bit view). A value that isn't shaped like a token is ignored and logged as malformed (the agent then behaves like a manual install).

### macOS configuration profile

Upload this as a custom profile, with your token in place of `PASTE_TOKEN_HERE` (two UUIDs are placeholders: any fresh UUIDs will do):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadIdentifier</key><string>com.aiproctor.agent.enrollment</string>
  <key>PayloadUUID</key><string>5E1A6C1E-0000-4000-8000-000000000001</string>
  <key>PayloadDisplayName</key><string>AI Proctor enrollment</string>
  <key>PayloadScope</key><string>System</string>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.aiproctor.agent</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>com.aiproctor.agent.enrollment.settings</string>
      <key>PayloadUUID</key><string>5E1A6C1E-0000-4000-8000-000000000002</string>
      <key>PayloadDisplayName</key><string>AI Proctor</string>
      <key>EnrollmentToken</key><string>PASTE_TOKEN_HERE</string>
    </dict>
  </array>
</dict>
</plist>
```

Tools that build the payload for you only need the preference domain `com.aiproctor.agent` and this property list:

```xml
<dict>
  <key>EnrollmentToken</key>
  <string>PASTE_TOKEN_HERE</string>
</dict>
```

## Jamf Pro (macOS)

1. **Token.** Computers → Configuration Profiles → New. Name it "AI Proctor enrollment", Level: Computer Level.
2. Payload **Application & Custom Settings** → Upload → Preference Domain `com.aiproctor.agent`, Property List: the `<dict>` above with your token. (Or upload the whole `.mobileconfig` above instead.)
3. Scope it to the computers that get AI Proctor, and save.
4. **Install** _(pending #55)_: Settings → Computer Management → Packages → add the signed `AI Proctor.pkg`; then a Policy with that package, scoped the same way, trigger Recurring Check-in (or Enrollment Complete), once per computer.
5. **Permissions** _(pending #55, needs the signed app's code requirement)_: a Privacy Preferences Policy Control payload for bundle id `com.aiproctor.agent`:
   - Screen Capture: "Allow Standard User to Set System Service". macOS doesn't let MDM grant Screen Recording outright; this lets a standard user approve it in the agent's onboarding.
   - Accessibility: Allow (optional; only used for browser domains when the org's policy samples activity).
   - Camera can't be granted by MDM; the employee approves it in onboarding.

## Kandji (macOS)

1. **Token.** Library → Add New → Custom Profile. Name it "AI Proctor enrollment" and upload the `.mobileconfig` above with your token.
2. Assign it to the Blueprints whose Macs get AI Proctor.
3. **Install** _(pending #55)_: Library → Add New → Custom App, upload the signed `AI Proctor.pkg` ("Installer Package"), install "Once per device", same Blueprints.
4. **Permissions** _(pending #55)_: Library → Privacy (PPPC) for bundle id `com.aiproctor.agent`, with the same settings as in the Jamf section.

Kandji manages Apple devices; for Windows computers use Intune.

## Microsoft Intune

### macOS

1. **Token.** Devices → macOS → Configuration → Create → New Policy → Templates → **Preference file**. Preference domain name `com.aiproctor.agent`, property list file: a `.plist` containing the `<dict>` above with your token. Assign to the device group.
2. **Install** _(pending #55)_: Apps → macOS → Add → macOS app (PKG), upload the signed `AI Proctor.pkg`, assign as Required.
3. **Permissions** _(pending #55)_: a Custom configuration profile with the PPPC payload described in the Jamf section.

### Windows

1. **Token.** Devices → Windows → Scripts and remediations → Platform scripts → Add. Run this script as SYSTEM, in 64-bit PowerShell, with your token:

   ```powershell
   $key = 'HKLM:\SOFTWARE\Policies\AIProctor\Agent'
   New-Item -Path $key -Force | Out-Null
   New-ItemProperty -Path $key -Name 'EnrollmentToken' -PropertyType String -Value 'PASTE_TOKEN_HERE' -Force | Out-Null
   ```

   Assign it to the device group. (Any tool that can write `HKLM` works the same: Group Policy Preferences, a remediation script, your RMM.)
2. **Install** _(pending #56)_: Apps → Windows → Add → Line-of-business app, upload `AI Proctor.msi`, assign as Required. The MSI will also take the token as a property, `msiexec /i "AI Proctor.msi" /qn ENROLLMENT_TOKEN=apet_…`, and write the same registry value; until #56 lands, use the script above.
3. Camera privacy: the employee allows desktop apps to use the camera in onboarding (Windows has no MDM grant for a single desktop app).

## Checking that it worked

- Dashboard → People → Device enrollment: the token's **Enrolled** count goes up and **Last used** is set after an employee's first sign-in.
- Audit log: "Enrolled a device" with the person and the token's name.
- On the computer, the agent's log at launch has `managed install: enrollment token found` with the token's prefix (never the token):
  - macOS: `~/Library/Logs/com.aiproctor.agent/agent.<date>.log`
  - Windows: `%LOCALAPPDATA%\com.aiproctor.agent\logs\agent.<date>.log`
- macOS: `defaults read "/Library/Managed Preferences/com.aiproctor.agent"` shows the delivered value.
- Windows: `reg query "HKLM\SOFTWARE\Policies\AIProctor\Agent" /v EnrollmentToken`.

## What the employee sees when enrollment is refused

The agent signs them out and shows a notification:

| Case | Message |
|---|---|
| They signed in with an account from another org | "This computer is managed by another organization. Sign in with your work account, or ask your IT team." |
| The token was revoked and this is a new install | "This computer's enrollment was revoked. Ask your IT team for a new configuration, then sign in again." |
| The token isn't known (typo, deleted org) | "This computer's enrollment token isn't valid. Ask your IT team to check the AI Proctor configuration." |

## Trying it without MDM (development)

- Seeded local token: `apet_local-test-token-for-acme-remote-not-secret` (local stack only, `supabase/seed.sql`).
- Debug builds take `AI_PROCTOR_DEV_ENROLLMENT_TOKEN=<token>` instead of the managed setting.
- macOS, as a real managed preference: `sudo defaults write "/Library/Managed Preferences/com.aiproctor.agent" EnrollmentToken <token>`, then `sudo killall cfprefsd`. Remove it afterwards with `sudo rm "/Library/Managed Preferences/com.aiproctor.agent.plist"` and `sudo killall cfprefsd`.
