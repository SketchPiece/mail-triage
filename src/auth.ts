import { readFile, writeFile } from "node:fs/promises";
import { authenticate } from "@google-cloud/local-auth";
import { auth, gmail as createGmail } from "@googleapis/gmail";

// Use the auth library bundled with @googleapis/gmail so client instances match its version.
type OAuth2Client = InstanceType<typeof auth.OAuth2>;

const ROOT = new URL("..", import.meta.url).pathname;
const CREDENTIALS_PATH = ROOT + "credentials.json";
const TOKEN_PATH = ROOT + "token.json";

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

async function loadSavedClient(): Promise<OAuth2Client | null> {
  try {
    const token = JSON.parse(await readFile(TOKEN_PATH, "utf8"));
    const client = new auth.OAuth2(token.client_id, token.client_secret);
    client.setCredentials({ refresh_token: token.refresh_token });
    // Fails fast if the refresh token expired (7 days in Testing mode).
    await client.getAccessToken();
    return client;
  } catch {
    return null;
  }
}

async function saveClient(client: OAuth2Client) {
  const { installed } = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
  const payload = {
    type: "authorized_user",
    client_id: installed.client_id,
    client_secret: installed.client_secret,
    refresh_token: client.credentials.refresh_token,
  };
  await writeFile(TOKEN_PATH, JSON.stringify(payload), { mode: 0o600 });
}

export async function getGmail() {
  let client = await loadSavedClient();
  if (!client) {
    client = (await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH })) as unknown as OAuth2Client;
    if (client.credentials.refresh_token) await saveClient(client);
  }
  return createGmail({ version: "v1", auth: client });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const gmail = await getGmail();
  const { data } = await gmail.users.getProfile({ userId: "me" });
  console.log(`Signed in as ${data.emailAddress}: ${data.messagesTotal} messages, ${data.threadsTotal} threads`);
}
