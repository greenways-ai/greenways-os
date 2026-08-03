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
 :project/capabilities [:canvas/webgl2 :input/pointer :ui/surfaces]

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

  :world/touchpoints
  [{:touchpoint/id studio-console
    :touchpoint/label "Open studio"
    :touchpoint/description "Arrange local recordings inside this world"
    :touchpoint/surface :studio
    :touchpoint/presentation :panel
    :touchpoint/transform {:world/position [1.8 1.1 -2.4]
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
required. Touchpoints are optional. IDs must be unique across layers, imports,
and touchpoints within a project. Positions use PlayCanvas world units,
rotations are XYZ Euler degrees, and scale is a positive uniform scalar.
Transforms compose from outer imports to the layer or touchpoint. Imported
camera and background declarations do not override the root.

An asset is a repository-relative `.sog` file or a streamed SOG
`lod-meta.json`. Absolute URLs, query strings, fragments, backslashes, empty
segments, and `.` or `..` path segments are rejected. Stream metadata is also
inspected so referenced resources remain below its directory on the same raw
GitHub commit origin.

## Touchpoints and 2D surfaces

A touchpoint is a semantic anchor in the 3D world. The viewer projects its
world transform into screen space and displays an accessible control over the
corresponding object or location. Activating that control sends the touchpoint
to the embedded Hara kernel. Hara updates the session state and requests a
named host surface through a `ui/open-surface` effect.

The host, rather than the world repository, owns the executable DOM surface.
This prevents a world from injecting arbitrary HTML or JavaScript. A world can
only request a surface that the current Hodos/Greenways host has installed.
The initial installed surface is `:studio`, a conventional 2D music workspace
that accepts local audio files through browser drag and drop.

Each touchpoint requires:

- `:touchpoint/id` — stable identifier within its project.
- `:touchpoint/label` — visible and accessible action label.
- `:touchpoint/surface` — installed surface identifier such as `:studio`.
- `:touchpoint/transform` — anchor transform composed with imports.

Optional fields are:

- `:touchpoint/description` — additional context and hover text.
- `:touchpoint/presentation` — `:panel` (default), `:modal`, or `:fullscreen`.

A project declaring touchpoints must include `:ui/surfaces` in
`:project/capabilities`. The capability authorises the request; it does not
make every named surface available.

The Hara session carries logical state such as the active surface and the
studio track list. Browser-native objects—including `File`, object URLs, audio
buffers, DOM nodes, and PlayCanvas entities—remain in the host and are referred
to by stable IDs.

## Refs and failure behavior

Dev mode permits a branch, tag, commit, or an omitted ref (the default branch).
The viewer resolves it through GitHub and fetches all manifests/assets from the
resulting commit. Strict mode requires a full 40-character commit SHA for the
root and every import.

The root manifest is required. A failed or cyclic import, unsafe stream, failed
splat layer, or failed touchpoint surface is isolated: other valid layers and
touchpoints continue to work and the viewer is prominently marked incomplete.

Limits are 1 MiB per manifest, 8 import levels, 24 distinct projects, 64
layers, and 128 touchpoints. The viewer supports public GitHub repositories
only and does not accept tokens or credentials.

## Preparing SOG assets

PlayCanvas's `splat-transform` CLI can convert supported Gaussian splat inputs:

```sh
npx @playcanvas/splat-transform input.ply world/output.sog
```

Commit the resulting SOG output and `project.edn` together. For reproducible
imports, publish and use the imported repository's complete commit SHA.
