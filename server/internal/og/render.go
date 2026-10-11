// Package og draws the link-preview cards that chat apps show for an invite link (Open
// Graph images), and the tags that point at them. A card is 1200x630 in the Living room
// look: warm near-black with a plum glow from the top left, the film's poster, its title,
// who's hosting and a plum "Join the screening" pill.
package og

import (
	"bytes"
	"embed"
	"image"
	"image/color"
	"image/jpeg"
	"math"
	"strings"
	"unicode"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

const (
	Width  = 1200
	Height = 630
	margin = 72
)

// Card is what a preview shows. A zero Card is Anda's own card, for links to anything
// that isn't a room.
type Card struct {
	Code   string // room code; "" for Anda's own card
	Host   string // the room's owner
	Film   string // on screen, or where the room left off; "" if nothing yet
	Year   string
	Poster image.Image // nil without one
}

// The Living room palette (web/app/globals.css).
var (
	ink900  = color.RGBA{0x11, 0x10, 0x0e, 0xff}
	glow    = color.RGBA{0x2e, 0x17, 0x29, 0xff} // lobby-bg's centre
	ink800  = color.RGBA{0x1e, 0x1c, 0x19, 0xff}
	fog50   = color.RGBA{0xf7, 0xf4, 0xee, 0xff}
	fog300  = color.RGBA{0xc6, 0xc0, 0xb5, 0xff}
	fog500  = color.RGBA{0x94, 0x8e, 0x83, 0xff}
	plum700 = color.RGBA{0x70, 0x29, 0x63, 0xff}
)

//go:embed fonts/*.ttf
var fontFiles embed.FS

var sans, sansMedium, sansSemi, mono *opentype.Font

func init() {
	load := func(name string) *opentype.Font {
		b, err := fontFiles.ReadFile("fonts/" + name)
		if err != nil {
			panic(err)
		}
		f, err := opentype.Parse(b)
		if err != nil {
			panic(err)
		}
		return f
	}
	sans = load("Geist-Regular.ttf")
	sansMedium = load("Geist-Medium.ttf")
	sansSemi = load("Geist-SemiBold.ttf")
	mono = load("GeistMono-Medium.ttf")
}

func face(f *opentype.Font, size float64) font.Face {
	fc, err := opentype.NewFace(f, &opentype.FaceOptions{Size: size, DPI: 72, Hinting: font.HintingNone})
	if err != nil {
		panic(err) // only for bad options, which are constant here
	}
	return fc
}

// Render draws c as a JPEG.
func Render(c Card) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, Width, Height))
	background(img)

	x := margin
	if c.Poster != nil {
		// 2:3, as tall as the card allows.
		h := Height - 2*margin
		w := h * 2 / 3
		poster(img, c.Poster, image.Rect(margin, margin, margin+w, margin+h))
		x = margin + w + 64
	}
	right := Width - margin
	width := right - x

	var label, title, sub, line, pill string
	switch {
	case c.Code == "":
		label = "ANDA"
		title = "Movie night,\nwherever everyone is."
		line = "Start a room, share the code, watch in sync."
		pill = "Start a room"
	case c.Film != "":
		label = "ANDA · ROOM " + c.Code
		title, sub = c.Film, c.Year
		line = c.Host + " is hosting"
		pill = "Join the screening"
	default:
		label = "ANDA · ROOM " + c.Code
		title = c.Host + "’s room"
		line = "Nothing on yet. Come pick a film."
		pill = "Join the room"
	}
	if c.Code != "" && c.Host == "" {
		line = ""
	}

	// Top: the label, then the title (as large as fits in three lines) and the year.
	labelFace := face(mono, 22)
	y := margin + 22
	text(img, labelFace, label, x, y, fog500, 2)

	y += 56
	var lines []string
	var titleFace font.Face
	var size float64
	for _, size = range []float64{68, 60, 52, 46} {
		titleFace = face(sansSemi, size)
		lines = wrap(titleFace, title, width, -size*0.025, 3)
		if !truncated(lines, title) {
			break
		}
	}
	lineHeight := int(math.Round(size * 1.08))
	for i, l := range lines {
		text(img, titleFace, l, x, y+int(size*0.78)+i*lineHeight, fog50, -size*0.025)
	}
	y += len(lines)*lineHeight + 14
	if sub != "" {
		text(img, face(sans, 30), sub, x, y+28, fog500, 0)
	}

	// Bottom: who's hosting, then the pill, lined up with the poster's bottom edge.
	pillFace := face(sansMedium, 28)
	pillH, padX := 68, 34
	pillW := measure(pillFace, pill, 0) + 2*padX
	pillTop := Height - margin - pillH
	roundRect(img, image.Rect(x, pillTop, x+pillW, pillTop+pillH), float64(pillH)/2, plum700)
	text(img, pillFace, pill, x+padX, pillTop+pillH/2+10, fog50, 0)
	if line != "" {
		lineFace := face(sans, 28)
		line = ellipsize(lineFace, line, width, 0)
		text(img, lineFace, line, x, pillTop-30, fog300, 0)
	}

	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: 88}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// background is lobby-bg: a plum glow (an ellipse 900x700 at 12% across, the top edge)
// fading into ink-900 by 62% of the way out. A little noise keeps the gradient from banding
// once it's a JPEG.
func background(img *image.RGBA) {
	cx, cy := 0.12*Width, 0.0
	seed := uint32(2463534242)
	for py := range Height {
		for px := range Width {
			dx, dy := (float64(px)-cx)/900, (float64(py)-cy)/700
			t := math.Min(math.Sqrt(dx*dx+dy*dy)/0.62, 1)
			seed ^= seed << 13
			seed ^= seed >> 17
			seed ^= seed << 5
			n := float64(seed%3) - 1 // -1, 0 or 1
			i := img.PixOffset(px, py)
			img.Pix[i+0] = clamp(lerp(glow.R, ink900.R, t) + n)
			img.Pix[i+1] = clamp(lerp(glow.G, ink900.G, t) + n)
			img.Pix[i+2] = clamp(lerp(glow.B, ink900.B, t) + n)
			img.Pix[i+3] = 0xff
		}
	}
}

// poster draws p cropped to fill r (centred), with rounded corners and a faint edge.
func poster(dst *image.RGBA, p image.Image, r image.Rectangle) {
	pb := p.Bounds()
	// Crop the source to r's aspect ratio, then scale.
	src := pb
	if pb.Dx()*r.Dy() > pb.Dy()*r.Dx() {
		w := pb.Dy() * r.Dx() / r.Dy()
		src.Min.X += (pb.Dx() - w) / 2
		src.Max.X = src.Min.X + w
	} else {
		h := pb.Dx() * r.Dy() / r.Dx()
		src.Min.Y += (pb.Dy() - h) / 2
		src.Max.Y = src.Min.Y + h
	}
	scaled := image.NewRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
	xdraw.CatmullRom.Scale(scaled, scaled.Bounds(), p, src, xdraw.Src, nil)

	roundRect(dst, r.Inset(-1), 29, ink800) // the edge, showing 1px around the poster
	const radius = 28
	for y := range r.Dy() {
		for x := range r.Dx() {
			a := coverage(float64(x)+0.5, float64(y)+0.5, float64(r.Dx()), float64(r.Dy()), radius)
			if a <= 0 {
				continue
			}
			si, di := scaled.PixOffset(x, y), dst.PixOffset(r.Min.X+x, r.Min.Y+y)
			for k := range 3 {
				dst.Pix[di+k] = clamp(float64(dst.Pix[di+k])*(1-a) + float64(scaled.Pix[si+k])*a)
			}
		}
	}
}

// roundRect fills r with c, corners rounded to radius, anti-aliased.
func roundRect(dst *image.RGBA, r image.Rectangle, radius float64, c color.RGBA) {
	r = r.Intersect(dst.Bounds())
	w, h := float64(r.Dx()), float64(r.Dy())
	for y := range r.Dy() {
		for x := range r.Dx() {
			a := coverage(float64(x)+0.5, float64(y)+0.5, w, h, radius)
			if a <= 0 {
				continue
			}
			i := dst.PixOffset(r.Min.X+x, r.Min.Y+y)
			dst.Pix[i+0] = clamp(float64(dst.Pix[i+0])*(1-a) + float64(c.R)*a)
			dst.Pix[i+1] = clamp(float64(dst.Pix[i+1])*(1-a) + float64(c.G)*a)
			dst.Pix[i+2] = clamp(float64(dst.Pix[i+2])*(1-a) + float64(c.B)*a)
		}
	}
}

// coverage is how much of the pixel centred at (x, y) lies inside a w x h rectangle at the
// origin with corners rounded to radius: 1 inside, 0 outside, in between along the edge.
func coverage(x, y, w, h, radius float64) float64 {
	radius = math.Min(radius, math.Min(w, h)/2)
	qx := math.Abs(x-w/2) - (w/2 - radius)
	qy := math.Abs(y-h/2) - (h/2 - radius)
	d := math.Hypot(math.Max(qx, 0), math.Max(qy, 0)) + math.Min(math.Max(qx, qy), 0) - radius
	return math.Max(0, math.Min(1, 0.5-d))
}

// text draws s with its baseline at (x, y), adding tracking (px) between letters.
func text(dst *image.RGBA, f font.Face, s string, x, y int, c color.RGBA, tracking float64) {
	d := font.Drawer{Dst: dst, Src: image.NewUniform(c), Face: f, Dot: fixed.P(x, y)}
	prev := rune(-1)
	for _, r := range s {
		if prev >= 0 {
			d.Dot.X += f.Kern(prev, r) + fixed.Int26_6(tracking*64)
		}
		d.DrawString(string(r))
		prev = r
	}
}

// measure is s's width in pixels, as text draws it.
func measure(f font.Face, s string, tracking float64) int {
	var w fixed.Int26_6
	prev := rune(-1)
	for _, r := range s {
		if prev >= 0 {
			w += f.Kern(prev, r) + fixed.Int26_6(tracking*64)
		}
		adv, _ := f.GlyphAdvance(r)
		w += adv
		prev = r
	}
	return w.Ceil()
}

// wrap breaks s into at most maxLines lines no wider than width, starting a new line at
// each "\n" and ending the last with an ellipsis when the rest doesn't fit.
func wrap(f font.Face, s string, width int, tracking float64, maxLines int) []string {
	var lines []string
	for _, p := range strings.Split(s, "\n") {
		if len(lines) == maxLines {
			lines[maxLines-1] = ellipsize(f, lines[maxLines-1]+" "+p, width, tracking)
			break
		}
		lines = append(lines, wrapParagraph(f, p, width, tracking, maxLines-len(lines))...)
	}
	return lines
}

func wrapParagraph(f font.Face, s string, width int, tracking float64, maxLines int) []string {
	words := strings.FieldsFunc(s, unicode.IsSpace)
	var lines []string
	cur := ""
	for i := 0; i < len(words); i++ {
		next := strings.TrimSpace(cur + " " + words[i])
		if measure(f, next, tracking) <= width || cur == "" {
			cur = next
			continue
		}
		lines = append(lines, cur)
		cur = words[i]
		if len(lines) == maxLines-1 {
			// Last line: everything left, shortened if needed.
			cur = strings.Join(words[i:], " ")
			break
		}
	}
	if cur != "" {
		lines = append(lines, cur)
	}
	for i, l := range lines {
		if measure(f, l, tracking) > width {
			lines[i] = ellipsize(f, l, width, tracking)
		}
	}
	return lines
}

// truncated reports whether wrap had to drop or shorten any of s.
func truncated(lines []string, s string) bool {
	return strings.Join(lines, " ") != strings.Join(strings.Fields(s), " ")
}

// ellipsize shortens s with "…" until it fits width.
func ellipsize(f font.Face, s string, width int, tracking float64) string {
	if measure(f, s, tracking) <= width {
		return s
	}
	r := []rune(s)
	for len(r) > 0 {
		r = r[:len(r)-1]
		cand := strings.TrimRightFunc(string(r), unicode.IsSpace) + "…"
		if measure(f, cand, tracking) <= width {
			return cand
		}
	}
	return "…"
}

func lerp(a, b uint8, t float64) float64 { return float64(a) + (float64(b)-float64(a))*t }

func clamp(v float64) uint8 { return uint8(math.Max(0, math.Min(255, math.Round(v)))) }
