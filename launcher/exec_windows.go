//go:build windows

package main

import (
	"os"
	"os/exec"
)

// Windows には exec がないので、子として起こし、入出力をそのまま渡して終わるのを待つ。
// 起動用のプログラムが強制終了されたときに子が残らないようにするには、ジョブオブジェクトが要る（未実装）。
func runServer(bin string, args []string) {
	cmd := exec.Command(bin, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		logf("サーバーを起動できません: %v", err)
		os.Exit(1)
	}
	os.Exit(0)
}
