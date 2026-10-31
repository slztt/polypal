# What makes a model printable

- **Watertight**: no holes, so the slicer knows what is inside and outside.
- **One piece, or pieces that touch**: floating fragments print as loose debris.
- **Consistent normals**: inside-out patches confuse slicers.
- **Real size**: STL has no units; slicers assume millimetres.
- **Flat-ish base**: a model resting on a point needs supports or a brim.
- **Wall thickness**: thin parts under ~1 mm (FDM) may not print; scale up or thicken.
