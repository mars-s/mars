import assert from "node:assert/strict";
import test from "node:test";
import { imageChips, imageDirective, nextImageLabel, plainImageChips, resolveImageChips, userParts, withoutAttachmentLines } from "../lib/pi/image-chips.ts";

const A = "a".repeat(64), B = "b".repeat(64);

test("chips are found in order and numbered after the highest", () => {
  const text = `make ${imageDirective("Image 1", "draft-1")} like ${imageDirective("Image 3", "draft-3")}`;
  assert.deepEqual(imageChips(text).map((chip) => [chip.label, chip.id]), [["Image 1", "draft-1"], ["Image 3", "draft-3"]]);
  assert.equal(nextImageLabel(text), "Image 4");
  assert.equal(nextImageLabel("no images"), "Image 1");
  assert.equal(plainImageChips(text), "make [Image 1] like [Image 3]");
});

test("chips point at host ids when sent; a chip without its image keeps its label", () => {
  const text = `${imageDirective("Image 1", "draft-1")} then ${imageDirective("Image 2", "gone")}`;
  assert.equal(resolveImageChips(text, new Map([["draft-1", A]])), `:image[Image 1]{name=${A}} then [Image 2]`);
});

test("a sent message reads in order with each image where the host placed it", () => {
  const images = [{ id: A, name: "cat.png", url: "/api/attachments/" + A }, { id: B, name: "old.png", url: "/api/attachments/" + B }];
  const text = `Make this\nAttachment ${A}: cat.png [Image 1]\nlook nicer`;
  assert.deepEqual(userParts(text, images), [
    { type: "text", text: "Make this" },
    { type: "image", image: images[0], label: "Image 1" },
    { type: "text", text: "look nicer" },
    { type: "image", image: images[1], label: "" },
  ]);
  assert.equal(withoutAttachmentLines(text), "Make this\nlook nicer");
  // A line that only looks like one, for an image that is not attached, stays text.
  assert.deepEqual(userParts(`Attachment ${B}: x`, []), [{ type: "text", text: `Attachment ${B}: x` }]);
});

test("chips still in a message's text are placed too", () => {
  const images = [{ id: A, name: "cat.png", url: "/api/attachments/" + A }];
  assert.deepEqual(userParts(`:image[Image 1]{name=${A}} :image[Image 2]{name=${A}} Retry caption`, images), [
    { type: "image", image: images[0], label: "Image 1" },
    { type: "text", text: "[Image 2] Retry caption" },
  ]);
});
