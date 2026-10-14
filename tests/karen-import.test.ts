import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayName, pickMainFile } from "@/lib/karen-import";
import { parseKarenCommand } from "@/lib/karen-intent";

describe("K.A.R.E.N.：外部の 3D モデルの取り込み", () => {
  it("一緒に選ばれたファイルの中から本体を選ぶ（.bin・画像・.mtl は本体ではない）", () => {
    const f = (name: string) => ({ name });
    assert.equal(pickMainFile([f("scene.bin"), f("tex.png"), f("scene.gltf")])?.name, "scene.gltf");
    assert.equal(pickMainFile([f("chair.mtl"), f("Chair.OBJ")])?.name, "Chair.OBJ");
    assert.equal(pickMainFile([f("part.stl")])?.name, "part.stl");
    assert.equal(pickMainFile([f("a.png"), f("b.bin")]), null);
  });

  it("表示用の名前は拡張子を外す", () => {
    assert.equal(displayName("my_robot-arm.glb"), "my robot arm");
    assert.equal(displayName(".glb"), "取り込んだモデル");
  });

  it("「取り込んで」「インポート」でファイル選択を開く（書き出しとは区別する）", () => {
    for (const t of ["3Dモデルを取り込んで", "GLBをインポートして", "ファイルを読み込んで"]) {
      assert.deepEqual(parseKarenCommand(t).ops, [{ kind: "import" }], t);
    }
    assert.deepEqual(parseKarenCommand("GLBで書き出して").ops, [{ kind: "export" }]);
  });
});
