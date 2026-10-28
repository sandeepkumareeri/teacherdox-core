# Quickstart — five minutes

You need **Node.js 22 or newer** and **git**. Nothing else: TeacherDox Core has no runtime
dependencies, so there is no `npm install` for anything below. Every command works the same in
Windows PowerShell and in a Linux or macOS shell; where they differ, both are shown.

## 1. Get it and run the tests (1 minute)

```bash
git clone https://github.com/sandeepkumareeri/teacherdox-core
cd teacherdox-core
npm test
```

You should see `# pass` with the number of tests and `# fail 0`.

## 2. Verify a signed teaching day (1 minute)

`verifier/samples/` holds a synthetic educator-day: four signed records (one of them a correction),
the day's seal, a headmaster's countersignature, and the public key that signed them.

```bash
node bin/tdx verify verifier/samples/day-demo.json --keys verifier/samples/keys-demo.json
```

```
✓ 01a17cb2-a2d7-7603-be90-f2fee09db646  confirmed_locked  2026-10-28 · P2 · 8B · Mathematics · Fractions
✓ 01a17cb2-a2dc-7892-8e2c-4303fd0b1290  confirmed_locked (superseded)  2026-10-28 · P4 · 9A · Mathematics · Linear equations
✓ 01a17cb2-a2de-7f87-82de-9b691d161f02  confirmed_locked  2026-10-28 · P6 · 8B · Science · Force and pressure
✓ 01a17cb2-a2e1-778c-a594-db46011e29c2  confirmed_locked  2026-10-28 · P4 · 9A · Mathematics · Linear equations
✓ day t_demo|e_demo_teacher|2026-10-28: 4 signed, chain intact, seal valid
✓ countersignature: headmaster e_demo_headmaster approved (whole day)
VALID
```

Every record is signed and unchanged, the day's chain has no gaps, the seal covers exactly these
four records, and the approval points at this day. The P4 record was corrected later: the original
is still there, marked `superseded`.

## 3. Change one word and verify again (1 minute)

Make a copy where "Fractions" becomes "Decimals" (this `node -e` line works in PowerShell and bash):

```bash
node -e "const f=require('fs');f.writeFileSync('tampered.json',f.readFileSync('verifier/samples/day-demo.json','utf8').replace('Fractions','Decimals'))"
node bin/tdx verify tampered.json --keys verifier/samples/keys-demo.json
```

```
✗ 01a17cb2-a2d7-7603-be90-f2fee09db646  confirmed_locked (superseded)  2026-10-28 · P2 · 8B · Mathematics · Decimals
    signature does not match content (capsule altered or wrong key)
…
✗ day t_demo|e_demo_teacher|2026-10-28: 3 signed, chain broken, seal INVALID
    …
    merkle root does not match the records
    seal covers 4 records, 3 given
INVALID
```

The changed record no longer matches its signature, so it drops out of the day. The verifier then
reports the gap in the chain, and the seal no longer matches. The exit code is `1`, so scripts can rely
on it. Delete the copy afterwards (`rm tampered.json` or, in PowerShell, `Remove-Item tampered.json`).

## 4. Verify in the browser (1 minute)

```bash
node bin/tdx serve
```

Open <http://127.0.0.1:8080/verify/> and press **Load a sample day** (or open your own file and paste
the issuer's key registry), then press **Change one homework line** to see a changed record fail. The page verifies
**in your browser** with WebCrypto, using a second implementation that must agree with the
command line, and uploads nothing. Stop the server with Ctrl+C.

The same server is the REST API (`/v1`); see [`api.md`](api.md).

## 5. Make your own signing key (30 seconds)

```bash
node bin/tdx keygen my-school-2026 --out keys
```

This writes `keys/my-school-2026.pem` (the private key: keep it secret, never commit it; `keys/` is
in `.gitignore`) and `keys/my-school-2026.public.json`, the entry to publish in your key registry.
On Windows the key file cannot be restricted with file modes; see
[`SECURITY.md`](../SECURITY.md#windows-private-key-file-permissions) for how to lock down the folder.

## 6. Turn a photo into a record (optional, needs a Meta Model API key)

```powershell
# PowerShell
$env:META_API_KEY = "<your key>"
'{"tenant":"t_demo","educator_ref":"e_demo","institution_ref":"i_demo","institution_type":"school","country":"IN","locale":"en-IN","date":"2026-10-28","channel":"api"}' | Out-File -Encoding ascii context.json
node bin/tdx process --image test/fixtures/board-synthetic.jpg --context context.json
```

```bash
# bash
export META_API_KEY=<your key>
echo '{"tenant":"t_demo","educator_ref":"e_demo","institution_ref":"i_demo","institution_type":"school","country":"IN","locale":"en-IN","date":"2026-10-28","channel":"api"}' > context.json
node bin/tdx process --image test/fixtures/board-synthetic.jpg --context context.json
```

SAM 3.1 finds the board, Muse Spark reads it and a second Muse Spark call checks the reading against
the photo. You get a draft `.tdx` record with a confidence for each field and the routing decision
(`auto_lock`, `confirm` or `hold`). [`how-a-record-is-born.md`](how-a-record-is-born.md) walks
through a real run step by step. If `ffmpeg` is installed, the board is cropped before reading;
without it the whole photo is read.

## Next

- The format: [`spec/tdx-2.0.md`](../spec/tdx-2.0.md) and the JSON Schema
  [`spec/schema/tdx-2.0.schema.json`](../spec/schema/tdx-2.0.schema.json)
- Check another implementation against the test vectors: [`spec/vectors/`](../spec/vectors/README.md)
- What a signature proves and what it does not: [`SECURITY.md`](../SECURITY.md)
- Model results on synthetic data: [`eval/RESULTS.md`](../eval/RESULTS.md)
