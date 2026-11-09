#!/usr/bin/env python3
"""Cut the single Clax illustration into jointed rig parts.

Input : assets/player_body.webp, player_leg_0.webp, player_leg_1.webp (646x686, registered)
Output: assets/rig_*.webp + src/rig.json (crop origin, size and pivot of each part, image coords)
Also trims the torn-paper border off the three background paintings.
Run:  python3 tools/cut_rig.py   (from clax/)
"""
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

A = os.path.join(os.path.dirname(__file__), '..', 'assets')
body = Image.open(f'{A}/player_body.webp').convert('RGBA')
legs = [Image.open(f'{A}/player_leg_{i}.webp').convert('RGBA') for i in (0, 1)]
W, H = body.size

def mask(poly, feather=0.8):
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).polygon(poly, fill=255)
    return m.filter(ImageFilter.GaussianBlur(feather)) if feather else m

def take(src, m):
    out = src.copy()
    a = np.array(out)
    a[:, :, 3] = (a[:, :, 3].astype(np.float32) * np.array(m, dtype=np.float32) / 255).astype(np.uint8)
    return Image.fromarray(a)

def inv(m):
    return Image.fromarray(255 - np.array(m))

def mul(*ms):
    r = np.ones((H, W), np.float32)
    for m in ms:
        r *= np.array(m, np.float32) / 255
    return Image.fromarray((r * 255).astype(np.uint8))

# ---- masks (image coordinates) ------------------------------------------------
ARM = [(0, 180), (228, 180), (228, 288), (252, 296), (256, 345), (232, 352), (226, 400),
       (252, 436), (252, 462), (232, 470), (232, 650), (0, 650)]
PINCER = [(0, 347), (122, 347), (136, 372), (150, 392), (200, 404), (226, 392), (226, 400),
          (252, 436), (252, 462), (232, 470), (232, 650), (0, 650)]
JAW = [(168, 414), (252, 438), (252, 462), (233, 472), (233, 506), (223, 513), (223, 541),
       (200, 564), (189, 531), (171, 533), (173, 503), (146, 504), (144, 472), (159, 440)]
HEAD = [(322, 212), (306, 190), (300, 150), (330, 60), (338, 0), (432, 0), (520, 52), (592, 62),
        (594, 92), (568, 140), (568, 160), (549, 168), (546, 200), (540, 214), (486, 236),
        (430, 242), (374, 236)]
HEAD_KEEP = [(x, y - 14) for x, y in HEAD]          # torso keeps a 14px overlap band
HAND = [(570, 284), (646, 284), (646, 482), (578, 482), (578, 425), (596, 410), (600, 335), (572, 322)]

m_arm, m_pincer, m_jaw = mask(ARM), mask(PINCER), mask(JAW)
m_head, m_headkeep, m_hand = mask(HEAD), mask(HEAD_KEEP), mask(HAND)

parts = {}
parts['upper'] = (take(body, mul(m_arm, inv(m_pincer))), (236, 316))        # gauge + amplifier, pivot = shoulder
parts['pincer'] = (take(body, mul(m_arm, m_pincer, inv(m_jaw))), (156, 394))  # big jaw, pivot = wrist
parts['jaw'] = (take(body, mul(m_arm, m_jaw)), (163, 408))                 # small jaw, pivot = hinge bolt
parts['head'] = (take(body, m_head), (430, 236))
parts['hand'] = (take(body, m_hand), (590, 304))

# torso: body minus limbs; patch the notch the arm leaves by mirroring pixels across the cut
torso = take(body, mul(inv(m_arm), inv(m_headkeep), inv(m_hand)))
t = np.array(torso).astype(np.float32)
src = np.array(body).astype(np.float32)
for y in range(186, 292):
    for d in range(1, 30):
        xs, xd = 229 + d, 229 - d
        fall = max(0.0, 1 - d / 26.0) ** 0.6
        px = src[y, xs].copy(); px[3] *= fall
        if px[3] > t[y, xd, 3]:
            t[y, xd] = px
for y in range(346, 452):                      # lower ring, behind the pincer
    for d in range(1, 22):
        xs, xd = 234 + d, 234 - d
        fall = max(0.0, 1 - d / 18.0) ** 0.6
        px = src[y, xs].copy(); px[3] *= fall
        if px[3] > t[y, xd, 3]:
            t[y, xd] = px
parts['torso'] = (Image.fromarray(t.astype(np.uint8)), (402, 452))          # pivot = pelvis

# legs: shaft (hip -> ankle, stretched at runtime) + boot (pivot at ankle)
LEG = [dict(hip=(338, 454), ankle=(291, 544), cut=540), dict(hip=(468, 456), ankle=(493, 552), cut=548)]
for i, (im, g) in enumerate(zip(legs, LEG)):
    top = Image.new('L', (W, H), 0); ImageDraw.Draw(top).rectangle([0, 0, W, g['cut'] + 14], fill=255)
    bot = Image.new('L', (W, H), 0); ImageDraw.Draw(bot).rectangle([0, g['cut'] - 4, W, H], fill=255)
    parts[f'shaft{i}'] = (take(im, top), g['hip'])
    parts[f'boot{i}'] = (take(im, bot), g['ankle'])

meta = {'origin': [398, 684], 'height': H, 'legs': LEG, 'parts': {}}
for name, (im, pivot) in parts.items():
    box = im.getbbox()
    box = (max(0, box[0] - 2), max(0, box[1] - 2), min(W, box[2] + 2), min(H, box[3] + 2))
    im.crop(box).save(f'{A}/rig_{name}.webp', quality=92, method=6)
    meta['parts'][name] = {'x': box[0], 'y': box[1], 'w': box[2] - box[0], 'h': box[3] - box[1], 'px': pivot[0], 'py': pivot[1]}
    print(name, box, pivot)
json.dump(meta, open(os.path.join(os.path.dirname(__file__), '..', 'src', 'rig.json'), 'w'), indent=1)

# ---- backgrounds: trim the torn-paper border -----------------------------------
for n in ('yard', 'fortress', 'carnival'):
    p = f'{A}/{n}_background.webp'
    im = Image.open(p).convert('RGB')
    if im.size == (1056, 750):
        im.crop((16, 16, 1040, 734)).save(p, quality=90, method=6)
        print('trimmed', n)
