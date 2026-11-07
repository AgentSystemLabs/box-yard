// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, uploadFile } from "../web/src/lib/api.js"
import { stubUploads } from "./fakeUpload.js"

afterEach(() => vi.unstubAllGlobals())

const file = new File(["hello"], "notes v2.txt", { type: "text/plain" })
const saved = { id: "upload_abc123", name: "notes v2.txt", size: 5, mime: "text/plain" }

describe("uploadFile", () => {
  it("posts the raw file and resolves with the saved attachment", async () => {
    const sent = stubUploads((upload) => upload.respond(201, saved))
    await expect(uploadFile(file)).resolves.toEqual(saved)
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/uploads?name=notes%20v2.txt", body: file, headers: { "Content-Type": "application/octet-stream" } })
  })

  it("names a nameless (pasted) file", async () => {
    const sent = stubUploads((upload) => upload.respond(201, saved))
    await uploadFile(new File(["x"], ""))
    expect(sent[0]!.url).toBe("/api/uploads?name=pasted-file")
  })

  it("reports the share sent as it goes", async () => {
    const sent = stubUploads()
    const onProgress = vi.fn()
    const done = uploadFile(file, { onProgress })
    sent[0]!.progress(1, 4)
    sent[0]!.upload.onprogress!({ lengthComputable: false, loaded: 3, total: 0 })
    sent[0]!.progress(4, 4)
    sent[0]!.respond(201, saved)
    await done
    expect(onProgress.mock.calls).toEqual([[0.25], [1]])
  })

  it("rejects with the server's error, or its status when it gave none", async () => {
    stubUploads((upload) => upload.respond(413, { error: '"big.zip" is larger than the 20 MB upload limit.' }))
    await expect(uploadFile(file)).rejects.toMatchObject({ message: '"big.zip" is larger than the 20 MB upload limit.', status: 413 })
    stubUploads((upload) => upload.respond(502, "<html>Bad gateway</html>"))
    const err = await uploadFile(file).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ message: "Upload failed (502)", status: 502 })
  })

  it("says the server can't be reached when the request never lands", async () => {
    stubUploads((upload) => upload.fail())
    await expect(uploadFile(file)).rejects.toMatchObject({ message: "Can't reach the Box Yard server. Is it running?", status: 0 })
  })

  it("asks to sign in again on a 401", async () => {
    stubUploads((upload) => upload.respond(401, { error: "Sign in" }))
    const unauthorized = vi.fn()
    window.addEventListener("box-yard:unauthorized", unauthorized)
    await expect(uploadFile(file)).rejects.toMatchObject({ status: 401 })
    window.removeEventListener("box-yard:unauthorized", unauthorized)
    expect(unauthorized).toHaveBeenCalledOnce()
  })

  it("cancels with its signal, before or during the upload", async () => {
    const sent = stubUploads()
    const control = new AbortController()
    const pending = uploadFile(file, { signal: control.signal })
    control.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(sent[0]!.aborted).toBe(true)
    await expect(uploadFile(file, { signal: control.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(sent).toHaveLength(1)
  })
})
