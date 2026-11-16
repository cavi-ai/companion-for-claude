# Error handling with Result

Functions that can fail return Result instead of throwing. The question mark operator propagates an error to the caller early. Define a custom error enum and implement From to convert library errors.
