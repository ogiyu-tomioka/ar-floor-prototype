# Third-party notices

This diagnostic uses unmodified third-party libraries, distributed locally. No paid hosted AR service is used. Application JavaScript is separate from these libraries.

## 8th Wall Distributed Engine Binary

This product includes the XR Engine software developed by Niantic Spatial, Inc.
Copyright © 2026 Niantic Spatial, Inc. All rights reserved.

This dependency is covered by the XR ENGINE LICENSE AGREEMENT, not the MIT licenses of the other libraries. Retain the complete unmodified `vendor/xr` directory and its LICENSE. The 13 distributed files match ARRollCapture's recorded dependency hashes. Only the SLAM chunk is requested; other distributed resources are retained unmodified.

- [Local license](vendor/xr/LICENSE)
- [Upstream license and source distribution](https://github.com/8thwall/engine)
- [Binary/open-source distinction](https://8thwall.org/docs/open-source)
- Original archive: https://media.githubusercontent.com/media/8thwall/engine/main/xr-standalone.zip
- Original archive SHA-256: a2fc73ba450c1a96ee2a20db442f7fb328a3c8b76565e7e9d15b68cd75c86a93

## Three.js 0.164.0

Copyright 2010-2024 Three.js Authors. MIT license. Unmodified `three.module.js` from the pinned npm package.

- [Local license](vendor/THREE-LICENSE.txt)
- [Source](https://github.com/mrdoob/three.js/tree/r164)

## AR.js 3.4.8

Copyright (c) 2020 AR.js. MIT license. Unmodified `ar-threex.mjs`, camera parameter sample, Hiro pattern and Hiro image from the 3.4.8 release.

- [Local license](vendor/ARJS-LICENSE.txt)
- [Source](https://github.com/AR-js-org/AR.js/tree/3.4.8)
- [Official marker example used as an API reference](https://github.com/AR-js-org/AR.js/blob/3.4.8/three.js/examples/basic.html)

The bundled tracker includes ARToolKit. ARToolKit is primarily LGPLv3 with additional permission for static linking; its terms are distinct from AR.js's MIT license. Retain the full terms:

- [ARToolKit license, LGPL/GPL texts and additional permission](vendor/ARTOOLKIT-LICENSE.txt)
- [JavaScript port source repository](https://github.com/andypotato/artoolkit5-js)
- [Published port package corresponding to the AR.js dependency](https://www.npmjs.com/package/@ar-js-org/artoolkit5-js/v/0.3.2)

All downloaded file origins, byte sizes and SHA-256 values are recorded in [DEPENDENCY-HASHES.json](DEPENDENCY-HASHES.json). Camera processing remains within the page; these diagnostic pages do not upload images or diagnostics. Downloading a library is not evidence of runtime compatibility with this iPhone/Safari combination.
