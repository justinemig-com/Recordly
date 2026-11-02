import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("media server path policy", () => {
	let tempRoot: string;
	let appDataPath: string;
	let userDataPath: string;
	let tempPath: string;
	let appPath: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-media-server-"));
		appDataPath = path.join(tempRoot, "AppData");
		userDataPath = path.join(tempRoot, "UserData");
		tempPath = path.join(tempRoot, "Temp");
		appPath = path.join(tempRoot, "App");

		await Promise.all(
			[appDataPath, userDataPath, tempPath, appPath].map((dirPath) =>
				fs.mkdir(dirPath, { recursive: true }),
			),
		);

		vi.resetModules();
		vi.doMock("electron", () => ({
			app: {
				isPackaged: false,
				getAppPath: () => appPath,
				getPath: (name: string) => {
					if (name === "appData") return appDataPath;
					if (name === "userData") return userDataPath;
					if (name === "temp") return tempPath;
					return tempRoot;
				},
				setPath: () => undefined,
			},
		}));
	});

	afterEach(async () => {
		vi.resetModules();
		vi.doUnmock("electron");
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("rejects existing media files outside the session directories until they are approved", async () => {
		const downloadsPath = path.join(tempRoot, "Downloads");
		const videoPath = path.join(downloadsPath, "personal-video.mp4");
		await fs.mkdir(downloadsPath, { recursive: true });
		await fs.writeFile(videoPath, "test-video");

		const { isAllowedMediaPath } = await import("./mediaServer");
		const { rememberApprovedLocalReadPath } = await import("./ipc/project/manager");

		expect(isAllowedMediaPath(videoPath)).toBe(false);

		await rememberApprovedLocalReadPath(videoPath);

		expect(isAllowedMediaPath(videoPath)).toBe(true);
	});

	it("rejects missing media files outside the allowed directories", async () => {
		const missingPath = path.join(tempRoot, "Downloads", "missing.mp4");
		const { isAllowedMediaPath } = await import("./mediaServer");

		expect(isAllowedMediaPath(missingPath)).toBe(false);
	});

	it("requires a path-bound token while preserving authorized playback and ranges", async () => {
		const firstPath = path.join(tempRoot, "first.mp4");
		const secondPath = path.join(tempRoot, "second.mp4");
		const unapprovedPath = path.join(tempRoot, "unapproved.mp4");
		await Promise.all([
			fs.writeFile(firstPath, "first-video"),
			fs.writeFile(secondPath, "second-video"),
			fs.writeFile(unapprovedPath, "private-video"),
		]);

		const { buildMediaUrl, ensureMediaServer } = await import("./mediaServer");
		const { rememberApprovedLocalReadPath } = await import("./ipc/project/manager");
		await rememberApprovedLocalReadPath(firstPath);
		await rememberApprovedLocalReadPath(secondPath);

		const baseUrl = await ensureMediaServer();
		const authorizedUrl = buildMediaUrl(baseUrl, firstPath);
		const authorized = await fetch(authorizedUrl);
		expect(authorized.status).toBe(200);
		expect(await authorized.text()).toBe("first-video");
		expect((await fetch(authorizedUrl, { method: "HEAD" })).status).toBe(200);
		const range = await fetch(authorizedUrl, { headers: { Range: "bytes=1-3" } });
		expect(range.status).toBe(206);
		expect(await range.text()).toBe("irs");
		expect((await fetch(authorizedUrl, { headers: { Range: "bytes=99-" } })).status).toBe(416);
		expect((await fetch(authorizedUrl, { method: "OPTIONS" })).status).toBe(204);

		const withoutToken = new URL(authorizedUrl);
		withoutToken.searchParams.delete("token");
		const blocked = await fetch(withoutToken);
		expect(blocked.status).toBe(403);
		expect(blocked.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(await blocked.text()).not.toContain("first-video");

		const wrongToken = new URL(authorizedUrl);
		wrongToken.searchParams.set("token", "0".repeat(64));
		expect((await fetch(wrongToken)).status).toBe(403);
		const swappedPath = new URL(authorizedUrl);
		swappedPath.searchParams.set("path", secondPath);
		expect((await fetch(swappedPath)).status).toBe(403);
		const duplicateToken = new URL(authorizedUrl);
		duplicateToken.searchParams.append("token", duplicateToken.searchParams.get("token") ?? "");
		expect((await fetch(duplicateToken)).status).toBe(403);
		expect((await fetch(buildMediaUrl(baseUrl, unapprovedPath))).status).toBe(403);
	});
});

describe("resolveHttpByteRange", () => {
	it("rejects malformed and multi-range headers", async () => {
		const { resolveHttpByteRange } = await import("./mediaServer");

		expect(resolveHttpByteRange("bytes=0-1,2-3", 100)).toBeNull();
		expect(resolveHttpByteRange("bytes=0-1foo", 100)).toBeNull();
	});

	it("clamps oversized explicit end offsets to EOF", async () => {
		const { resolveHttpByteRange } = await import("./mediaServer");

		expect(resolveHttpByteRange("bytes=0-9999999999", 3_221_225_472)).toEqual({
			start: 0,
			end: 3_221_225_471,
		});
	});

	it("rejects ranges that start beyond EOF", async () => {
		const { resolveHttpByteRange } = await import("./mediaServer");

		expect(resolveHttpByteRange("bytes=500-999", 500)).toBeNull();
	});

	it("preserves suffix range semantics", async () => {
		const { resolveHttpByteRange } = await import("./mediaServer");

		expect(resolveHttpByteRange("bytes=-500", 1_000)).toEqual({
			start: 500,
			end: 999,
		});
	});
});
