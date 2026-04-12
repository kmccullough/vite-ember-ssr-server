// A component that renders nothing — like HeadLayout, NetworkBanner, etc.
// This triggers a Glimmer rehydration mismatch because the empty comment
// marker (<!---->) doesn't match the expected element from the next component.
<template>
  {{! intentionally empty }}
</template>
