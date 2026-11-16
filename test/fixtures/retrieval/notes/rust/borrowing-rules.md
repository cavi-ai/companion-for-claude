# Borrowing rules

You may hold many shared references or exactly one mutable reference, never both at once. The borrow checker enforces this at compile time and prevents data races. Shorten the scope of a reference to resolve conflicts.
