# @avex/design

`tokens.css` is the visual system: colours (light and dark), type scale, spacing, radii,
shadows, motion. Every page inlines it at build time in place of the marker
`/* @inject:tokens */` at the top of its stylesheet, so all four surfaces — site, dashboard,
checkout, admin — are one system by construction rather than by discipline.

Pages extend these tokens; they never redefine them. Light is the default; dark follows the
system preference or `data-theme="dark"` on the root.
