export const FEATURED_WORLDS = Object.freeze([
  Object.freeze({
    id: "apartment",
    title: "Apartment",
    description: "A minimal world built from one compact SOG asset.",
    repository: "https://github.com/greenways-worlds/apartment",
    format: "SOG",
    attribution: "https://github.com/greenways-worlds/apartment/blob/main/ATTRIBUTION.md",
  }),
  Object.freeze({
    id: "playbot",
    title: "Playbot",
    description: "A streamed, multi-resolution SOG world.",
    repository: "https://github.com/greenways-worlds/playbot",
    format: "STREAMED SOG",
    attribution: "https://github.com/greenways-worlds/playbot/blob/main/ATTRIBUTION.md",
  }),
  Object.freeze({
    id: "splat-garden",
    title: "Splat Garden",
    description: "Apartment and Playbot composed from immutable repository imports.",
    repository: "https://github.com/greenways-worlds/splat-garden",
    format: "COMPOSED WORLD",
    attribution: "https://github.com/greenways-worlds/splat-garden",
  }),
]);

export function featuredWorld(id) {
  return FEATURED_WORLDS.find((world) => world.id === id) ?? null;
}
