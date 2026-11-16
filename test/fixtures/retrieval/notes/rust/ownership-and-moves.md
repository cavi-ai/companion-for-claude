# Ownership and moves

Each value has exactly one owner. Assigning a String to another variable moves it, and the original binding can no longer be used. When the owner goes out of scope the value is dropped and its memory freed. Clone to make an explicit deep copy.
