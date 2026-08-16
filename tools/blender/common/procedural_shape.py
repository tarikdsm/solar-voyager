"""Seeded small-body relief: value-noise fBm plus analytic craters.

Pure float64 Python with no Blender and no numpy dependency, so the field can be
unit-tested on the system interpreter and evaluated identically for mesh vertices
and albedo texels. Every random quantity descends from the catalogue's
``visual.proceduralSeed``; there is no other entropy source.
"""

import math


PERMUTATION_SIZE = 256
DEFAULT_RELIEF = 0.16
DEFAULT_OCTAVES = 5
DEFAULT_FREQUENCY = 2.6
DEFAULT_LACUNARITY = 2.03
DEFAULT_GAIN = 0.5
DEFAULT_CRATER_COUNT = 18
DEFAULT_CRATER_DEPTH = 0.09
MAX_SEED = 0xFFFFFFFF


class _Random:
    """SplitMix64 — a fixed, self-contained stream so results never depend on
    the host Python's `random` implementation."""

    __slots__ = ("_state",)

    def __init__(self, seed):
        self._state = seed & 0xFFFFFFFFFFFFFFFF

    def next_uint64(self):
        self._state = (self._state + 0x9E3779B97F4A7C15) & 0xFFFFFFFFFFFFFFFF
        value = self._state
        value = ((value ^ (value >> 30)) * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
        value = ((value ^ (value >> 27)) * 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
        return value ^ (value >> 31)

    def unit(self):
        return self.next_uint64() / 18446744073709551616.0

    def between(self, low, high):
        return low + (high - low) * self.unit()


def _permutation(seed):
    table = list(range(PERMUTATION_SIZE))
    stream = _Random(seed)
    for index in range(PERMUTATION_SIZE - 1, 0, -1):
        swap = stream.next_uint64() % (index + 1)
        table[index], table[swap] = table[swap], table[index]
    return tuple(table + table)


def _smoothstep(value):
    return value * value * (3.0 - 2.0 * value)


def _lattice_value(table, x, y, z):
    hashed = table[(table[(table[x & 255] + y) & 255] + z) & 255]
    return hashed / 255.0


def _value_noise(table, x, y, z):
    """Trilinear smoothstep value noise in [0, 1]."""
    x0 = math.floor(x)
    y0 = math.floor(y)
    z0 = math.floor(z)
    tx = _smoothstep(x - x0)
    ty = _smoothstep(y - y0)
    tz = _smoothstep(z - z0)
    x0 = int(x0)
    y0 = int(y0)
    z0 = int(z0)

    result = 0.0
    for offset_z, weight_z in ((0, 1.0 - tz), (1, tz)):
        for offset_y, weight_y in ((0, 1.0 - ty), (1, ty)):
            for offset_x, weight_x in ((0, 1.0 - tx), (1, tx)):
                corner = _lattice_value(table, x0 + offset_x, y0 + offset_y, z0 + offset_z)
                result += corner * weight_x * weight_y * weight_z
    return result


def fbm(table, direction, octaves, frequency, lacunarity=DEFAULT_LACUNARITY, gain=DEFAULT_GAIN):
    """Fractal Brownian motion of `_value_noise`, normalized to [-1, 1]."""
    total = 0.0
    amplitude = 1.0
    normalization = 0.0
    scale = frequency
    for _ in range(octaves):
        sample = _value_noise(
            table, direction[0] * scale, direction[1] * scale, direction[2] * scale
        )
        total += amplitude * (sample * 2.0 - 1.0)
        normalization += amplitude
        amplitude *= gain
        scale *= lacunarity
    return total / normalization


def _unit(direction):
    x, y, z = (float(component) for component in direction)
    length = math.sqrt(x * x + y * y + z * z)
    if not math.isfinite(length) or length <= 0.0:
        raise ValueError("Shape direction must be a finite non-zero vector")
    return x / length, y / length, z / length


def _validate_seed(seed):
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= MAX_SEED:
        raise ValueError(f"Procedural seed must be an integer in [0, {MAX_SEED}]; received {seed!r}")
    return seed


class ProceduralShape:
    """Radial relief field for a small body, evaluated per unit direction."""

    def __init__(
        self,
        *,
        seed,
        relief=DEFAULT_RELIEF,
        octaves=DEFAULT_OCTAVES,
        frequency=DEFAULT_FREQUENCY,
        crater_count=DEFAULT_CRATER_COUNT,
        crater_depth=DEFAULT_CRATER_DEPTH,
        axis_ratios=(1.0, 1.0, 1.0),
    ):
        self.seed = _validate_seed(seed)
        if not math.isfinite(relief) or not 0.0 <= relief <= 0.5:
            raise ValueError(f"Shape relief must be within [0, 0.5]; received {relief!r}")
        if isinstance(octaves, bool) or not isinstance(octaves, int) or octaves < 1:
            raise ValueError(f"Shape octaves must be an integer >= 1; received {octaves!r}")
        if not math.isfinite(frequency) or frequency <= 0.0:
            raise ValueError(f"Shape frequency must be positive; received {frequency!r}")
        if isinstance(crater_count, bool) or not isinstance(crater_count, int) or crater_count < 0:
            raise ValueError(f"Shape crater count must be a non-negative integer; received {crater_count!r}")
        if not math.isfinite(crater_depth) or not 0.0 <= crater_depth <= 0.5:
            raise ValueError(f"Shape crater depth must be within [0, 0.5]; received {crater_depth!r}")
        ratios = tuple(axis_ratios)
        if len(ratios) != 3 or any(
            not math.isfinite(ratio) or not 0.0 < ratio <= 1.0 for ratio in ratios
        ):
            raise ValueError(f"Shape axis ratios must be three values in (0, 1]; received {axis_ratios!r}")

        self.relief = float(relief)
        self.octaves = octaves
        self.frequency = float(frequency)
        self.crater_depth = float(crater_depth)
        self.axis_ratios = tuple(float(ratio) for ratio in ratios)
        self._relief_table = _permutation(self.seed)
        self._shade_table = _permutation((self.seed + 0x5F35_6495) & 0xFFFFFFFFFFFFFFFF)
        self._craters = self._seed_craters(crater_count)

    @property
    def crater_count(self):
        return len(self._craters)

    def _seed_craters(self, count):
        stream = _Random((self.seed * 0x2545F4914F6CDD1D + 0x1D8E_4E27) & 0xFFFFFFFFFFFFFFFF)
        craters = []
        for _ in range(count):
            z = stream.between(-1.0, 1.0)
            azimuth = stream.between(0.0, 2.0 * math.pi)
            horizontal = math.sqrt(max(0.0, 1.0 - z * z))
            direction = (horizontal * math.cos(azimuth), horizontal * math.sin(azimuth), z)
            angular_radius = stream.between(0.12, 0.55)
            strength = stream.between(0.35, 1.0)
            craters.append((direction, angular_radius, strength))
        return tuple(craters)

    def _crater_offset(self, direction):
        if not self._craters or self.crater_depth <= 0.0:
            return 0.0
        deepest = 0.0
        for centre, angular_radius, strength in self._craters:
            cosine = (
                direction[0] * centre[0] + direction[1] * centre[1] + direction[2] * centre[2]
            )
            angle = math.acos(max(-1.0, min(1.0, cosine)))
            if angle >= angular_radius:
                continue
            # Bowl floor with a raised rim: -cos over the bowl, positive near the edge.
            normalized = angle / angular_radius
            profile = math.cos(normalized * math.pi) * 0.5 + 0.5
            rim = 0.22 * math.sin(normalized * math.pi) ** 8
            deepest = max(deepest, strength * (profile - rim))
        return deepest * self.crater_depth

    def radius(self, direction):
        """Normalized radius (nominal 1.0) along `direction`."""
        unit = _unit(direction)
        relief = 0.0
        if self.relief > 0.0:
            relief = self.relief * fbm(self._relief_table, unit, self.octaves, self.frequency)
        return 1.0 + relief - self._crater_offset(unit)

    def point(self, direction):
        """Displaced surface point, with the authored triaxial ratios applied."""
        unit = _unit(direction)
        radius = self.radius(unit)
        return (
            unit[0] * radius * self.axis_ratios[0],
            unit[1] * radius * self.axis_ratios[1],
            unit[2] * radius * self.axis_ratios[2],
        )

    def shade(self, direction):
        """Albedo modulation in [0, 1]: regolith mottling on an independent channel."""
        unit = _unit(direction)
        mottle = fbm(self._shade_table, unit, 4, self.frequency * 2.4)
        fine = fbm(self._shade_table, unit, 2, self.frequency * 9.0)
        value = 0.5 + 0.34 * mottle + 0.12 * fine
        return max(0.0, min(1.0, value))


def equirectangular_direction(u, v):
    """Direction for an equirectangular texel, matching the mesh UV convention.

    `common/geometry._apply_equirectangular_uv` uses
    ``u = 0.5 + atan2(-y, x) / 2pi`` and ``v = 0.5 + asin(z) / pi`` in the Blender
    Z-up authoring frame; this is that mapping inverted.
    """
    latitude = (v - 0.5) * math.pi
    z = math.sin(latitude)
    horizontal = math.cos(latitude)
    angle = (u - 0.5) * 2.0 * math.pi
    return (horizontal * math.cos(angle), -horizontal * math.sin(angle), z)


def shade_field(shape, width, height):
    """Row-major albedo modulation for a `width` x `height` equirectangular map.

    Every texel is evaluated directly. Sampling on a coarse grid and bilinearly
    upsampling was measured at roughly five times faster but visibly softer (peak
    deviation 0.066 at the shipped 1024x512 tier) — not a trade worth making for
    a one-off authoring step.
    """
    for label, value in (("width", width), ("height", height)):
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError(f"Shade field {label} must be an integer >= 1; received {value!r}")
    return [
        shape.shade(equirectangular_direction((column + 0.5) / width, (row + 0.5) / height))
        for row in range(height)
        for column in range(width)
    ]
