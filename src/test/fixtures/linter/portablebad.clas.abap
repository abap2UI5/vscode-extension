CLASS zcl_portable_bad DEFINITION PUBLIC.
  " One construct outside the portable profile v1 per marked line, each a
  " different `reason` of portable-app (test/review/portable.mjs)
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA name TYPE string.
    DATA rating TYPE i.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_portable_bad IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    IF client->check_on_init( ).

      DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
      DATA(page) = view->ele( n = `View` ns = `mvc`
          )->a( n = `xmlns` v = `sap.m`
          )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
          )->a( n = `xmlns:f` v = `sap.f`
          )->a( n = `xmlns:z2ui5` v = `z2ui5.cc`
          )->a( n = `xmlns:app` v = `http://schemas.sap.com/sapui5/extension/sap.ui.core.CustomData/1`
          )->ele( `Page`
              )->a( n = `title` v = `Not portable` ).

      " control: sap.m.RatingIndicator is not in the profile
      page->tag( `RatingIndicator`
          )->a( n = `value` v = client->_bind( rating ) ).
      " control: a whole excluded namespace
      page->tag( n = `Avatar` ns = `f` ).
      " custom-control: z2ui5.cc
      page->tag( n = `Favicon` ns = `z2ui5` ).
      " member: Button iconFirst is not listed, nor is a custom-data attribute
      page->tag( `Button`
          )->a( n = `text` v = `Go`
          )->a( n = `iconFirst` v = `false`
          )->a( n = `app:key` v = `go`
          )->a( n = `press` v = client->_event( `GO` ) ).
      " binding: a named model and an odata type
      page->tag( `Text`
          )->a( n = `text` v = `{i18n>title}` ).
      page->tag( `Input`
          )->a( n = `value` v = `{path:'/NAME', type:'sap.ui.model.odata.type.String'}` ).
      " expression: RegExp and an unlisted method
      page->tag( `Text`
          )->a( n = `visible` v = `{= RegExp('^A').test(${/NAME}) }` ).
      " event-argument: the raw UI5 event, an unlisted parameter, an object call
      page->tag( `Input`
          )->a( n = `value` v = client->_bind( name )
          )->a( n = `submit` v = client->_event( val = `SUBMIT` t_arg = VALUE #( ( `$event.oSource.sId` ) ( `${$parameters>/selectedItem}` ) ) ) ).
      page->tag( `Select`
          )->a( n = `change` v = client->_event( val = `PICK` arg = `${$parameters>/selectedItem}.getKey()` ) ).
      " event-wire: prevent_default_expr
      page->tag( `Link`
          )->a( n = `text` v = `Open`
          )->a( n = `press` v = client->_event( val = `OPEN` s_ctrl = VALUE #( prevent_default_expr = `true` ) ) ).

      client->view_display( view->stringify( ) ).

    ENDIF.

    CASE client->get( )-event.
      WHEN `GO`.
        " frontend-action: CONTROL_BY_ID is excluded
        client->follow_up_action( val = client->cs_event-control_by_id t_arg = VALUE #( ( `page` ) ( `setTitle` ) ( `x` ) ) ).
      WHEN `SUBMIT`.
        " frontend-action: an excluded CONTROL_GLOBAL target
        client->follow_up_action( val = client->cs_event-control_global t_arg = VALUE #( ( `ICON_POOL` ) ( `registerFont` ) ( `x` ) ( `y` ) ) ).
      WHEN `PICK`.
        " nested-view: decision Q1
        client->nest_view_display( val = view->stringify( ) id = `page` method_insert = `addContent` ).
      WHEN `OPEN`.
        " client-api: an excluded parameter
        client->view_display( val = view->stringify( ) switch_default_model_path = `/X` ).
    ENDCASE.

  ENDMETHOD.

ENDCLASS.
