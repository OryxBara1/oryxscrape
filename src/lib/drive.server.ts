// Server-only Google Drive v3 access through the Lovable connector gateway.
// Never import this from client code.

const GATEWAY = "https://connector-gateway.lovable.dev/google_drive";
const API = `${GATEWAY}/drive/v3`;
const UPLOAD = `${GATEWAY}/upload/drive/v3/files`;

const SHARED_DRIVE_PARAMS = "supportsAllDrives=true&includeItemsFromAllDrives=true";

function credentials() {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const connectionKey = process.env["GOOGLE_DRIVE_API_KEY"];
  if (!lovableKey || !connectionKey) {
    throw new Error(
      "Google Drive exchange is not configured: the Drive connection is not linked to this project.",
    );
  }
  return { lovableKey, connectionKey };
}

function authHeaders() {
  const { lovableKey, connectionKey } = credentials();
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": connectionKey,
  };
}

async function readError(res: Response, what: string): Promise<never> {
  const body = await res.text();
  console.error(`[drive] ${what} failed [${res.status}]: ${body}`);
  throw new Error(`Google Drive ${what} failed [${res.status}]: ${body}`);
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  createdTime?: string;
};

export async function createFolder(name: string, parentId: string): Promise<DriveFile> {
  const res = await fetch(`${API}/files?${SHARED_DRIVE_PARAMS}&fields=id,name,mimeType,parents`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!res.ok) await readError(res, "folder creation");
  return (await res.json()) as DriveFile;
}

export async function uploadTextFile(params: {
  name: string;
  parentId: string;
  mimeType: string;
  content: string;
}): Promise<DriveFile> {
  const boundary = `oryx${crypto.randomUUID().replace(/-/g, "")}`;
  const metadata = JSON.stringify({ name: params.name, parents: [params.parentId] });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${params.mimeType}\r\n\r\n${params.content}\r\n` +
    `--${boundary}--\r\n`;

  const res = await fetch(`${UPLOAD}?uploadType=multipart&${SHARED_DRIVE_PARAMS}&fields=id,name,mimeType,parents`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) await readError(res, "file upload");
  return (await res.json()) as DriveFile;
}


/** Overwrites the content of an existing Drive file (new revision, same file id). */
export async function updateTextFileContent(params: {
  fileId: string;
  mimeType: string;
  content: string;
}): Promise<DriveFile> {
  const res = await fetch(
    `${UPLOAD}/${params.fileId}?uploadType=media&${SHARED_DRIVE_PARAMS}&fields=id,name,mimeType`,
    {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": params.mimeType },
      body: params.content,
    },
  );
  if (!res.ok) await readError(res, "file content update");
  return (await res.json()) as DriveFile;
}

export async function listFolderInDrive(folderId: string, driveId: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await fetch(
    `${API}/files?q=${q}&${SHARED_DRIVE_PARAMS}&corpora=drive&driveId=${driveId}&fields=files(id,name,mimeType,createdTime)&pageSize=200`,
    { headers: authHeaders() },
  );
  if (!res.ok) await readError(res, "folder listing");
  const json = (await res.json()) as { files?: DriveFile[] };
  return json.files ?? [];
}

/** Returns the existing subfolder with this name, or creates it. */
export async function findOrCreateFolder(
  name: string,
  parentId: string,
  driveId: string,
): Promise<DriveFile> {
  const children = await listFolderInDrive(parentId, driveId);
  const existing = children.find(
    (f) => f.name === name && f.mimeType === "application/vnd.google-apps.folder",
  );
  if (existing) return existing;
  return await createFolder(name, parentId);
}

/** Moves a file/folder between parents (same shared drive). */
export async function moveFile(params: {
  fileId: string;
  addParentId: string;
  removeParentId: string;
}): Promise<DriveFile> {
  const res = await fetch(
    `${API}/files/${params.fileId}?addParents=${params.addParentId}&removeParents=${params.removeParentId}&${SHARED_DRIVE_PARAMS}&fields=id,name,mimeType,parents`,
    { method: "PATCH", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: "{}" },
  );
  if (!res.ok) await readError(res, "folder move");
  return (await res.json()) as DriveFile;
}


export async function getFileText(fileId: string): Promise<string> {
  const res = await fetch(`${API}/files/${fileId}?alt=media&${SHARED_DRIVE_PARAMS}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await readError(res, "file download");
  return await res.text();
}
