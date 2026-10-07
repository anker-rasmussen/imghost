// "How it was made" — editorial page: art direction, Earth plate, RCS physics, spin audit, bake pipeline.
import { h, reveal, FLEET_THEME, pad2 } from './util.js?v=43c75d9741074c83';

const A = 'assets/making/';
const fig = (name, w, hgt, alt, caption, cls = '') =>
  h('figure.mk-fig' + (cls ? '.' + cls : '') + '.reveal',
    h('img', { src: `${A}${name}.webp`, width: w, height: hgt, alt, loading: 'lazy', decoding: 'async' }),
    caption && h('figcaption.micro', caption));

const head = (n, id, kicker, title, intro) =>
  h('div.sec-head.reveal',
    h('div', h('p.micro.eyebrow', `${pad2(n)} · ${kicker}`), h('h2.display', { id }, title)),
    h('p', intro));

const prose = (...ps) => h('div.mk-prose.reveal', ps.map((p) => (typeof p === 'string' ? h('p', p) : p)));
const facts = (rows) => h('dl.mk-facts.reveal', rows.map(([k, v]) => h('div', h('dt.micro', k), h('dd', v))));

export function makingOf() {
  const hero = h('section.mk-hero', { 'aria-labelledby': 'mk-title' },
    h('div.wrap',
      h('p.micro.eyebrow', 'Colophon · process'),
      h('h1.display#title', { tabindex: '-1' }, 'How it', h('br'), h('em', 'was made')),
      h('p.lede', 'Five shipyards, one rule: a ship must read as a spacecraft before it reads as a brand. Here is how the fleet was designed, lit, tested and baked into a showroom that runs in your browser.')));

  const s1 = h('section.sec.mk', { 'aria-labelledby': 'mk-art' },
    h('div.wrap',
      head(1, 'mk-art', 'Art direction', 'Spacecraft first, brand second',
        'The canon overrides every brand rule. Identity comes from proportion, material, colour and ornament, never from borrowing another vehicle’s archetype.'),
      h('div.mk-cols',
        prose(
          'Version one of the fleet failed a simple verdict: the ships did not look like spacecraft. One read as an ocean freighter. Version two starts from the thrust axis and works outwards.',
          'Form follows thrust: main drives aft, mass balanced around the axis, RCS clusters at the extremities. Real hardware stays visible: drive bells, propellant tanks, radiators edge-on to the plume, sensor masts, docking collars and hardpoints.',
          'Aircraft and sea-ship cues are banned: no tail fins, rudders, keels, bows, funnels or propellers. Anything fin-like needs a space job, as a radiator, solar array, sensor mast or heat shield.'),
        h('ol.mk-steps.reveal',
          [['Thumbnail test', 'Silhouette alone, black on white at 128 px, must say spacecraft and which maker.'],
            ['70 / 20 / 10', 'One or two primary masses, a few secondary forms, clustered tertiary detail. Calm surfaces let the form breathe.'],
            ['Legible function', 'You can point at crew, cargo, propellant, power, heat rejection, propulsion, RCS, docking and sensors.'],
            ['Real anchors', 'Human-scale hatches of 0.9 × 1.9 m, handholds, RCS quads, panel lines that grow with the ship.']]
            .map(([t, p], i) => h('li', h('span.micro', pad2(i + 1)), h('h3', t), h('p', p))))),
      h('div.mk-strip.reveal',
        [['hero-atlantia', 'Atlantia showroom hall with a ship on its turntable', 'Atlantia'],
          ['hero-helios', 'Helios showroom hall with a pearl-white yacht', 'Helios'],
          ['hero-daedalus', 'Daedalus showroom hall with an industrial hauler', 'Daedalus'],
          ['hero-cydonia', 'Cydonia showroom hall with an armoured warship', 'Cydonia'],
          ['hero-kingsley', 'Kingsley showroom hall with a small racing craft', 'Kingsley']]
          .map(([n, alt, cap]) => fig(n, 1280, 720, alt, cap)))));

  const s2 = h('section.sec.mk', { 'aria-labelledby': 'mk-earth' },
    h('div.wrap',
      head(2, 'mk-earth', 'The Earth plate', 'One planet, rendered once',
        'Earth is 1,500 km below the camera and the camera moves only kilometres. So the planet only changes with view direction.'),
      h('div.mk-cols',
        prose(
          'Instead of marching a volumetric atmosphere on every frame, the Earth, its atmosphere and the stars are path-traced once into a 16384 × 8192 equirectangular plate, 512 samples, denoised, stored as 16-bit EXR.',
          'The plate is captured from the midpoint of the two shot camera paths, where parallax stays under 0.3 degrees. The film then uses it as the world: it is the backdrop and also the light, giving earthshine and reflections on hulls.',
          'The 16k buffer is tiled in 2048 px tiles to fit in 8 GB of VRAM. The scene constants (sun direction, orbit altitude, axial tilt) live in one shared module, so the plate and the film can never disagree.'),
        facts([['Resolution', '16384 × 8192'], ['Samples', '512, adaptive, denoised'], ['Orbit altitude', '1,500 km'], ['Max parallax', '< 0.3°'], ['Format', 'Equirectangular EXR, 16-bit']])),
      fig('earth-atmosphere', 1600, 450, 'Two frames of the same shot, a station shell and a ship over Earth, before and after the volumetric Rayleigh, Mie and ozone atmosphere', 'Atmosphere pass, before and after (Rayleigh, Mie, ozone)'),
      fig('earth-shot-a', 1280, 720, 'Film frame: a spinning station and a ship in orbit over the Earth plate', 'Film frame lit by the plate')));

  const s3 = h('section.sec.mk', { 'aria-labelledby': 'mk-rcs' },
    h('div.wrap',
      head(3, 'mk-rcs', 'RCS physics', 'Every nozzle decides for itself',
        'Thrusters do not glow because the ship is moving. Each one fires only when its push helps the manoeuvre.'),
      h('div.mk-cols',
        prose(
          'Each RCS nozzle knows two things about itself: the force it applies to the ship (opposite to its exhaust direction) and the torque that force makes about the centre of mass (position crossed with force, normalised by a 20 m lever arm).',
          'The flight path supplies the command: the lateral acceleration and the rotational acceleration the ship needs right now, in the ship’s own frame, each scaled to the range -1 to 1. The main and retro engines handle the thrust axis, so RCS only trims it.',
          'A nozzle’s firing level is its force times the linear command, plus its torque times the angular command, minus a small per-nozzle threshold. Positive and it fires; otherwise it stays dark. The threshold varies slightly per nozzle so the pattern never looks synthetic.',
          'Firing is pulsed in short discrete bursts of about 50 to 120 ms, as real thrusters are, and a hovering ship gets small station-keeping corrections that change about every 0.3 s.'),
        h('div.mk-formula.reveal', { role: 'img', 'aria-label': 'fire equals force dot linear command plus torque dot angular command, minus threshold' },
          h('p.micro', 'Per-nozzle rule'),
          h('code', 'fire = F · a + T · ω̇ − threshold'),
          h('p', 'F is force on the ship, T is torque, a is commanded lateral acceleration, ω̇ is commanded angular acceleration. Clamped to 0 to 1.')))));

  const s4 = h('section.sec.mk', { 'aria-labelledby': 'mk-spin' },
    h('div.wrap',
      head(4, 'mk-spin', 'Spin-safety audit', 'Every bay is checked through a full turn',
        'Turntable ships spin through 360 degrees. Nothing in the hall may be touched by any hull, at any angle.'),
      h('div.mk-cols',
        prose(
          'The room builder measures each hull in its largest state, gear down and fans or arrays deployed. The footprint is the convex hull of every part’s bounding box, which is deliberately conservative, and the turntable ship is tested as its full swept circle.',
          h('p', 'Clearance rules: walls, other ships and large structure need at least 8 m or 12% of ship length, whichever is larger. Ceilings need 6 m above the ship. Furniture, totems and the turntable edge need a 3 m walking aisle. Outdoor giants must sit wholly beyond the glass facade.'),
          'The site repeats the check independently in headless tests. Every bay is rotated in 5 degree steps against neighbours, walls, pillars and plinths, and a camera sweep of 432 views per hall must stay outside every hull box.'),
        facts([['Rotation step', '5°'], ['Camera views', '432 per hall'], ['Walls and ships', '≥ max(8 m, 12% L)'], ['Ceiling', '≥ 6 m'], ['Aisle', '≥ 3 m'], ['Halls', '5']])),
      h('div.mk-audit',
        fig('audit-cydonia-top', 1100, 810, 'Top-down audit diagram of the Cydonia hall: thick circles show each ship’s swept 360 degree disc, thin circles the keep-out radius, grey the walls and structure', 'Cydonia hall, top view. Thick: swept disc. Thin: keep-out radius.'),
        fig('audit-kingsley-top', 1100, 735, 'Top-down audit diagram of the Kingsley hall with swept discs and keep-out circles', 'Kingsley hall, top view'),
        fig('audit-atlantia-top', 1100, 611, 'Top-down audit diagram of the Atlantia hall with swept discs and keep-out circles', 'Atlantia hall, top view'),
        fig('audit-atlantia-side', 1100, 247, 'Side-on audit diagram of the Atlantia hall showing ship heights against the ceiling', 'Atlantia hall, side view: heights against the ceiling'))));

  const stages = [['Floor bake', 'Lighting and reflections baked into the floor texture.'], ['Shell bake', 'Walls, ceiling and structure.'], ['Sign bake', 'Signage and brand marks.'], ['Glow bake', 'Emissive lights and glass.'], ['Light probes', 'Probe samples so moving ships pick up room light.'], ['Env and bg HDR', 'Environment and backdrop maps for reflections and the view outside.'], ['glTF export', 'Meshopt-compressed geometry and WebP textures.'], ['Texture LODs', 'Streamed by on-screen size, so only the detail you can see is fetched.']];
  const s5 = h('section.sec.mk', { 'aria-labelledby': 'mk-bake' },
    h('div.wrap',
      head(5, 'mk-bake', 'Bake pipeline', 'Lit in Blender, shown in real time',
        'Each showroom is baked offline, so the browser only has to draw textures, not simulate light.'),
      h('ol.mk-stages.reveal', stages.map(([t, p], i) => h('li', h('span.micro', pad2(i + 1)), h('h3', t), h('p', p)))),
      prose('Each room runs through the same stages, one script per maker hall. The bakes land in a single raw glTF, which is then recompressed with WebP textures and meshopt, so a hall loads quickly and starts rendering at low texture detail while higher levels stream in.')));

  const foot = h('footer.foot', h('div.wrap',
    h('span.micro', 'The Aurelia Fleet · a real-time portfolio piece'),
    h('a.micro', { href: '#/' }, '← Back to the fleet')));

  return {
    title: 'How it was made — Aurelia Fleet', theme: FLEET_THEME,
    nodes: [h('div.making', hero, s1, s2, s3, s4, s5, foot)],
    mount(root) { reveal(root); },
    unmount() {},
  };
}
