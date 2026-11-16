# Lifetimes

A lifetime annotation tells the compiler how long a reference stays valid relative to others. A function returning a reference must say which input it borrows from. Structs holding references need a lifetime parameter, written like 'a.
