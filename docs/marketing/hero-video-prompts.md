# Hero video prompts

Five 8-second clips for the landing-page hero. They play in order, crossfade into each other and
loop, with promotion text laid over the left side by the site (never baked into the video). The
player and the promotion editor are described in [landing.md](landing.md).

Works with any text-to-video or image-to-video tool (Sora, Veo, Runway, Kling, Luma). Paste the
**style block** in front of each **shot prompt**. Generate 2–3 takes of each and keep the best.

## Style block (paste before every shot)

> Photorealistic cinematic footage, 24 fps, shot on a full-frame cinema camera with a 35 mm lens,
> shallow depth of field, smooth gimbal movement, slow and steady. Natural light with a cool
> Canadian-winter morning palette that warms through the day; soft contrast, true-to-life skin and
> materials, light film grain. A professional Canadian electrician wearing a hard hat, safety
> glasses, work gloves and a hi-vis jacket over a hoodie, shown mostly from behind or over the
> shoulder, hands in focus, face not the subject. Clean, organized, safe work. The left third of
> the frame is calm, darker and low-detail so text can sit over it. No text, no captions, no logos,
> no brand names, no readable screens, no watermarks, no people looking at the camera. No audio.

**Negative prompt** (where the tool has one): text, letters, logo, brand, watermark, subtitles,
distorted hands, extra fingers, sparks, fire, smoke, exposed live wires, unsafe ladder use,
cluttered frame, fast camera moves, shaky handheld, fisheye, cartoon, CGI look.

## Shot prompts

Each clip ends on a calm half-second with the camera still moving in the same direction the next
clip starts, so the crossfade reads as one shot.

**1. Arrival (dawn).** A white work van pulls up in front of a new-build two-storey house in a
Canadian suburban subdivision, light snow on the lawns, pink-blue dawn sky, porch light on. The
electrician steps out, grabs a tool bag and a tablet, and walks toward the framed front door. Camera
tracks slowly to the right at shoulder height. Ends as the electrician passes through the doorway
into warm work-light glow.

**2. Rough-in.** Inside the same house, bare wood studs and work lights. The electrician fastens a
blue plastic device box to a stud and feeds sheathed NMD90 cable through drilled holes, neat cable
runs along the studs. A tablet leans on a sawhorse showing a blurred floor plan. Camera begins
moving right, then slowly pushes in on gloved hands seating the cable in the box. Ends on the hands
pausing, centred right.

**3. Conduit bend.** A bright commercial unit with a polished concrete floor. Gloved hands use a
hand bender to bend a length of EMT conduit; pencil marks on the pipe, a tape measure beside it.
Slow arc around the bend from left to right, low angle. Ends on the finished offset held up against
the light.

**4. Panel.** A finished residential panelboard with neatly dressed wires and a labelled circuit
directory, a lockout tag hanging on the main breaker. The electrician checks a breaker with a
non-contact voltage tester. Soft work light from the left. Camera pulls back slowly to reveal the
tidy utility room. Ends on a still, wide, satisfying view of the panel.

**5. Wrap-up (evening).** A warm kitchen at dusk, snow falling outside the window. The electrician,
hard hat on the table, reviews an estimate on a tablet with a homeowner across the table (both seen
from behind or in soft focus), then taps to send it. Camera pushes in slowly toward the tablet's
blurred glow. Ends on calm, warm light — the loop then fades back to the dawn arrival.

## Phone versions

Repeat each prompt with "vertical 9:16 framing, subject in the lower two thirds, the top third calm
for text" in place of the left-third note. Upload both versions per slide in HQ → Promotions.

## Making the handovers seamless

- If the tool supports a start or end image (image-to-video, "first/last frame"), export the last
  frame of clip N and use it as the start image for clip N+1.
- Keep the same style block, lens and time-of-day progression for every clip; don't mix tools
  within one set.
- Trim each clip so its last second is slow; the player crossfades over about 0.8 s.
- Export H.264 MP4, 1920×1080 (and 1080×1920), 6–10 s, no audio, at most 8 Mbps; also export a JPG
  or WebP poster from a calm frame of each clip.

## Accuracy check before publishing

- PPE on everyone, nobody touching live parts, a lockout tag where a panel is open.
- Canadian look: tamper-resistant receptacles, metric-labelled conduit if any labels are readable
  (better: none readable), winter or shoulder-season light, no US flags or US-only fixtures.
- No real brands or logos on tools, vans, clothing or screens.
- Reject any take with warped hands, impossible wiring or unsafe ladder or tool use.

## Overlay text examples (set per promotion in HQ)

| promotion | eyebrow | headline | sub-line | button |
| --- | --- | --- | --- | --- |
| Always-on | Built for Canadian electricians | Quote, wire and get paid from one app | CEC 2024 built in. Try it free for 14 days. | Start free trial |
| Spring push | Spring rush is coming | Win more jobs with faster quotes | Draw the plan, count the boxes, send the estimate. | Start free trial |
| Trade show | See us at the show | Fishtape for your whole crew | $1 to start, credited to your first month. | Book a demo |
