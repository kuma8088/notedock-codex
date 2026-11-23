//go:build !windows

package main

import (
	"os"
	"syscall"
)

// Mac では、確かめ終わったサーバーと入れ替わる（起動用のプログラムは残らない）。
// 確かめてから入れ替わるまでのあいだに差し替えられる心配は、同じ利用者の権限を持つ相手だけ（保存先は 0700）。
func runServer(bin string, args []string) {
	err := syscall.Exec(bin, append([]string{bin}, args...), os.Environ())
	logf("サーバーを起動できません: %v", err)
	os.Exit(1)
}
