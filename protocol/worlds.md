# Repository-defined Gaussian splat worlds

Greenways OS can open a public GitHub repository as a world. The repository
root contains `project.edn`; assets and imported worlds are resolved at Git
commits before rendering. Parsing is data-only EDN—manifest forms are never
evaluated.

## `project.edn`

```clojure
{:hara/type :project
 :hara/version "1.0.0"
 :project/id greenways.example/fern-gully
 :project/version "1.0.0"
 :project/source-paths ["src"]
 :project/test-paths ["test"]
 :project/extension-paths []
 :project/capabilities [:canvas/webgl2 :input/pointer]

 :project/world
 {:world/version "1.0.0"
  :world/title "Fern Gully"
  :world/background "#102018"
  :world/camera {:world/position [1 2 5]
                 :world/target [0 1 0]
                 :world/fov 55}

  :world/layers
  [{:world/id grove
    :world/asset "world/grove.sog"
    :world/transform {:world/position [0 0 0]
                      :world/rotation [0 0 0]
                      :world/scale 1}}]

  :world/imports
  [{:world/id creek
    :world/repository "https://github.com/greenways-example/creek-world"
    :world/ref "0123456789012345678901234567890123456789"
    :world/transform {:world/position [12 0 -3]
                      :world/rotation [0 30 0]
                      :world/scale 0.75}}]}}
```

`world/layers` and `world/imports` are vectors and at least one entry is
required. IDs must be unique within a project. Positions use PlayCanvas world
units, rotations are XYZ Euler degrees, and scale is a positive uniform scalar.
Transforms compose from outer imports to the layer. Imported camera and
background declarations do not override the root.

An asset is a repository-relative `.sog` file or a streamed SOG
`lod-meta.json`. Absolute URLs, query strings, fragments, backslashes, empty
segments, and `.` or `..` path segments are rejected. Stream metadata is also
inspected so referenced resources remain below its directory on the same raw
GitHub commit origin.

## Refs and failure behavior

Dev mode permits a branch, tag, commit, or an omitted ref (the default branch).
The viewer resolves it through GitHub and fetches all manifests/assets from the
resulting commit. Strict mode requires a full 40-character commit SHA for the
root and every import.

The root manifest is required. A failed or cyclic import, unsafe stream, or
failed splat layer is isolated: other valid layers still render and the viewer
is prominently marked incomplete.

Limits are 1 MiB per manifest, 8 import levels, 24 distinct projects, and 64
layers. The viewer supports public GitHub repositories only and does not accept
tokens or credentials.

## Preparing SOG assets

PlayCanvas's `splat-transform` CLI can convert supported Gaussian splat inputs:

```sh
npx @playcanvas/splat-transform input.ply world/output.sog
```

Commit the resulting SOG output and `project.edn` together. For reproducible
imports, publish and use the imported repository's complete commit SHA.
