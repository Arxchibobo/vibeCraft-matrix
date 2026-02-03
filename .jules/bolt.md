## 2025-05-15 - [Avoid Recursive Object Lookup in Hot Loops]
**Learning:** Using `getObjectByName` or similar recursive search methods inside a per-frame `update()` loop is a significant performance bottleneck in Three.js, especially as the number of entities (sessions) grows. Each call traverses the scene graph, leading to O(N*M) complexity where N is the number of entities and M is the depth of the graph.
**Action:** Always cache references to child objects in the constructor or initialization phase when they need to be manipulated during animation or every frame.
